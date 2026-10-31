import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { FileTransferHandle, TransferOutcome } from '@mics/sdk'
import { createSingleFileTransfer } from './singleTransfer'
import {
  fileSize,
  hashFile,
  toError,
  transferStatePath,
  type FileTransferOptions,
} from './transferCommon'

/**
 * 分段（多 Range 连接）文件传输。
 *
 * 只对大小已知的大文件启用。先发一个 `bytes=0-0` 的探测请求：
 * - 返回 206 + 有效 Content-Range 才进入分段；
 * - 返回 200 / 416 / 探测失败时回退到单连接 `DownloaderHelper`。
 *
 * 分段状态写 `<.part>.segments.json`，暂停、失败与进程重启后都能从各段
 * 已落盘的字节继续。所有段写同一个 `.part` 的不同 offset，完成后由下载
 * 管线照常改名并校验 SHA1。
 */

const PROBE_TIMEOUT = 20_000
const REQUEST_TIMEOUT = 30_000
const MAX_REDIRECTS = 8
const SEGMENT_RETRIES = 3
const MIN_SEGMENT_BYTES = 4 * 1024 * 1024
const MAX_SEGMENTS = 8
const PROGRESS_THROTTLE = 500
const STATE_SAVE_INTERVAL = 1200
/** 恢复时每段回退的字节数：进程崩溃时最后一段可能还没真正落盘 */
const RESUME_OVERLAP = 1024 * 1024

interface RangeProbe {
  total: number
  etag: string
  lastModified: string
}

interface SegmentRange {
  start: number
  /** 包含 */
  end: number
  /** 已确认写入的字节数 */
  loaded: number
}

interface PersistedSegmentState {
  version: 1
  url: string
  size: number
  etag: string
  lastModified: string
  segments: SegmentRange[]
}

class RangeUnsupportedError extends Error {
  constructor(message = '服务端不支持分段下载') {
    super(message)
    this.name = 'RangeUnsupportedError'
  }
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function parseContentRange(value: string): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null
  const total = match[3] === '*' ? 0 : Number(match[3])
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number.isSafeInteger(total) && total > 0 ? total : 0,
  }
}

function segmentLength(segment: SegmentRange): number {
  return segment.end - segment.start + 1
}

export function createSegmentedFileTransfer(options: FileTransferOptions): FileTransferHandle {
  const statePath = transferStatePath(options.partPath)
  let state: PersistedSegmentState | null = null
  let totalSize = 0
  let stopRequested = false
  let running = false
  let finished = false
  let fatal = false
  let fatalError: Error | null = null
  let donePromise: Promise<void> = Promise.resolve()
  let doneResolve: (() => void) | null = null
  let fallbackHandle: FileTransferHandle | null = null
  let lastProgressAt = 0
  let lastPersistAt = 0
  let persistChain: Promise<void> = Promise.resolve()
  const controllers = new Set<AbortController>()
  const writers = new Set<WriteStream>()

  function abortAll(): void {
    for (const controller of controllers) controller.abort()
    for (const writer of writers) writer.destroy()
  }

  function loadedBytes(): number {
    if (!state) return 0
    return state.segments.reduce((sum, segment) => sum + segment.loaded, 0)
  }

  function report(force = false): void {
    if (!state || totalSize <= 0) return
    const now = Date.now()
    if (!force && now - lastProgressAt < PROGRESS_THROTTLE && loadedBytes() < totalSize) return
    lastProgressAt = now
    options.onProgress?.({
      loaded: Math.min(loadedBytes(), totalSize),
      total: totalSize,
    })
  }

  /** 把当前状态排进串行写入链，避免多个段同时 rename 同一个元数据文件 */
  function persist(force = false): Promise<void> {
    if (!state || finished) return Promise.resolve()
    const now = Date.now()
    if (!force && now - lastPersistAt < STATE_SAVE_INTERVAL) return persistChain
    const snapshot = JSON.stringify(state)
    persistChain = persistChain
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${statePath}.tmp`
        try {
          await writeFile(temporary, snapshot, 'utf8')
          await rename(temporary, statePath)
          lastPersistAt = Date.now()
        } catch {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      })
    return persistChain
  }

  async function flushState(): Promise<void> {
    if (finished) return
    await persistChain.catch(() => undefined)
    if (state) {
      // 上面的链可能写入的是更早的快照，这里强制写当前状态
      const temporary = `${statePath}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(state), 'utf8')
        await rename(temporary, statePath)
        lastPersistAt = Date.now()
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
  }

  function requestStream(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    redirects = 0,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      if (redirects > MAX_REDIRECTS) {
        reject(new Error('重定向次数过多'))
        return
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        reject(new Error(`无效的下载地址：${url}`))
        return
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error(`不支持的下载协议：${parsed.protocol}`))
        return
      }

      const secure = parsed.protocol === 'https:'
      const request = (secure ? https : http).request(
        url,
        {
          method: 'GET',
          headers,
          signal,
          agent: secure ? options.agents.https : options.agents.http,
        },
        (response) => {
          const status = response.statusCode ?? 0
          const location = headerValue(response.headers.location)
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            response.resume()
            let next: string
            try {
              next = new URL(location, url).toString()
            } catch {
              reject(new Error(`无效的重定向地址：${location}`))
              return
            }
            resolve(requestStream(next, headers, signal, redirects + 1))
            return
          }
          resolve(response)
        },
      )

      request.setTimeout(REQUEST_TIMEOUT, () => request.destroy(new Error('请求超时')))
      request.on('error', reject)
      request.end()
    })
  }

  async function probeRange(): Promise<RangeProbe | null> {
    const controller = new AbortController()
    controllers.add(controller)
    try {
      const response = await requestStream(
        options.url,
        {
          ...(options.headers ?? {}),
          Range: 'bytes=0-0',
          'Accept-Encoding': 'identity',
        },
        controller.signal,
      )
      try {
        const status = response.statusCode ?? 0
        if (status === 200 || status === 416) return null
        if (status !== 206) throw new Error(`HTTP ${status}`)
        const range = parseContentRange(headerValue(response.headers['content-range']))
        if (!range || range.total <= 0) return null
        return {
          total: range.total,
          etag: headerValue(response.headers.etag),
          lastModified: headerValue(response.headers['last-modified']),
        }
      } finally {
        response.destroy()
      }
    } finally {
      controllers.delete(controller)
      controller.abort()
    }
  }

  function createState(probe: RangeProbe): PersistedSegmentState | null {
    if (probe.total < MIN_SEGMENT_BYTES * 2) return null
    const requested = Math.round(options.segments ?? 4)
    const count = Math.min(
      MAX_SEGMENTS,
      Math.max(2, Number.isFinite(requested) ? requested : 4),
      Math.floor(probe.total / MIN_SEGMENT_BYTES),
    )
    if (count < 2) return null

    const base = Math.floor(probe.total / count)
    const segments: SegmentRange[] = []
    for (let index = 0; index < count; index++) {
      segments.push({
        start: index * base,
        end: index === count - 1 ? probe.total - 1 : (index + 1) * base - 1,
        loaded: 0,
      })
    }
    return {
      version: 1,
      url: options.url,
      size: probe.total,
      etag: probe.etag,
      lastModified: probe.lastModified,
      segments,
    }
  }

  function validSegments(segments: SegmentRange[], total: number): boolean {
    let expected = 0
    for (const segment of segments) {
      if (
        !Number.isInteger(segment.start)
        || !Number.isInteger(segment.end)
        || !Number.isInteger(segment.loaded)
        || segment.start !== expected
        || segment.end < segment.start
        || segment.end >= total
        || segment.loaded < 0
        || segment.loaded > segmentLength(segment)
      ) {
        return false
      }
      expected = segment.end + 1
    }
    return expected === total
  }

  async function loadState(probe: RangeProbe): Promise<PersistedSegmentState | null> {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') return null
      const record = raw as Partial<PersistedSegmentState>
      if (
        record.version !== 1
        || record.url !== options.url
        || record.size !== probe.total
        || !Array.isArray(record.segments)
      ) {
        return null
      }
      if (probe.etag && record.etag && probe.etag !== record.etag) return null
      if (probe.lastModified && record.lastModified && probe.lastModified !== record.lastModified) {
        return null
      }
      if (!validSegments(record.segments, probe.total)) return null

      // 进程可能没来得及把最后几个写请求落盘；恢复时每段回退一小段重下
      const fileBytes = fileSize(options.partPath)
      if (fileBytes <= 0) {
        for (const segment of record.segments) segment.loaded = 0
      } else {
        for (const segment of record.segments) {
          const available = Math.min(
            segment.loaded,
            Math.max(0, fileBytes - segment.start),
          )
          segment.loaded = Math.max(0, available - (available > 0 ? RESUME_OVERLAP : 0))
        }
      }
      return {
        version: 1,
        url: record.url,
        size: record.size,
        etag: record.etag ?? '',
        lastModified: record.lastModified ?? '',
        segments: record.segments,
      }
    } catch {
      return null
    }
  }

  async function preparePart(): Promise<void> {
    if (!state) return
    // 先截到正确的总长度；分段写用 r+ 按 offset 写入。
    // Windows 上以 append 模式打开的文件不允许 ftruncate，必须用 r+/w+。
    let handle
    try {
      handle = await open(options.partPath, 'r+')
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw cause
      handle = await open(options.partPath, 'w+')
    }
    try {
      await handle.truncate(totalSize)
    } finally {
      await handle.close()
    }
  }

  function allDone(): boolean {
    return Boolean(state) && state!.segments.every((segment) => segment.loaded >= segmentLength(segment))
  }

  async function finish(): Promise<TransferOutcome> {
    finished = true
    await persistChain.catch(() => undefined)
    let digest: string | undefined
    if (options.sha1) {
      digest = await hashFile(options.partPath)
    }
    await rm(statePath, { force: true }).catch(() => undefined)
    await rm(`${statePath}.tmp`, { force: true }).catch(() => undefined)
    report(true)
    return { status: 'done', ...(digest ? { digest } : {}) }
  }

  async function fallback(reason: string): Promise<TransferOutcome> {
    finished = true
    abortAll()
    await persistChain.catch(() => undefined)
    if (stopRequested) return { status: 'paused' }
    await rm(options.partPath, { force: true }).catch(() => undefined)
    await rm(statePath, { force: true }).catch(() => undefined)
    await rm(`${statePath}.tmp`, { force: true }).catch(() => undefined)
    options.onRestart?.()
    void reason
    const handle = createSingleFileTransfer(options)
    fallbackHandle = handle
    try {
      return await handle.start()
    } finally {
      fallbackHandle = null
    }
  }

  async function downloadSegmentOnce(segment: SegmentRange): Promise<void> {
    const controller = new AbortController()
    controllers.add(controller)
    try {
      const start = segment.start + segment.loaded
      const headers: Record<string, string> = {
        ...(options.headers ?? {}),
        Range: `bytes=${start}-${segment.end}`,
        'Accept-Encoding': 'identity',
      }
      if (state?.etag) headers['If-Range'] = state.etag
      else if (state?.lastModified) headers['If-Range'] = state.lastModified

      const response = await requestStream(options.url, headers, controller.signal)
      try {
        if (stopRequested) throw new Error('已取消')
        const status = response.statusCode ?? 0
        if (status === 200) throw new RangeUnsupportedError()
        if (status === 416) {
          if (segment.loaded >= segmentLength(segment)) return
          throw new Error('服务端拒绝了剩余分段的 Range 请求')
        }
        if (status !== 206) throw new Error(`HTTP ${status}`)

        const range = parseContentRange(headerValue(response.headers['content-range']))
        if (!range || range.total !== totalSize || range.start !== start) {
          throw new RangeUnsupportedError('服务端返回的 Content-Range 与请求不一致')
        }

        const writer = createWriteStream(options.partPath, { flags: 'r+', start })
        // 暂停/取消时 abortAll 会 destroy 写入流；写回调会收到错误，
        // 这里再挂一个空监听，避免 Node 把 error 事件升级成未捕获异常。
        writer.on('error', () => undefined)
        writers.add(writer)
        try {
          for await (const chunk of response) {
            if (stopRequested) throw new Error('已取消')
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            await new Promise<void>((resolve, reject) => {
              writer.write(buffer, (error) => error ? reject(error) : resolve())
            })
            segment.loaded += buffer.length
            report()
            void persist()
          }
          await new Promise<void>((resolve, reject) => {
            writer.once('error', reject)
            writer.end(() => {
              writer.off('error', reject)
              resolve()
            })
          })
        } finally {
          writers.delete(writer)
          writer.destroy()
        }
      } finally {
        response.destroy()
      }
    } finally {
      controllers.delete(controller)
      controller.abort()
    }
  }

  async function downloadSegment(segment: SegmentRange): Promise<void> {
    let attempts = 0
    while (!stopRequested && !fatal && segment.loaded < segmentLength(segment)) {
      try {
        await downloadSegmentOnce(segment)
        if (segment.loaded < segmentLength(segment)) {
          attempts += 1
          if (attempts >= SEGMENT_RETRIES) {
            fatal = true
            fatalError = new Error('分段下载未完成')
            abortAll()
            throw fatalError
          }
          continue
        }
        return
      } catch (cause) {
        if (stopRequested || fatal) throw cause
        if (cause instanceof RangeUnsupportedError) {
          fatal = true
          fatalError = cause
          abortAll()
          throw cause
        }
        attempts += 1
        if (attempts >= SEGMENT_RETRIES) {
          fatal = true
          fatalError = toError(cause)
          abortAll()
          throw cause
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempts))
      }
    }
    if (segment.loaded < segmentLength(segment)) {
      throw new Error(stopRequested ? '已取消' : '分段下载未完成')
    }
  }

  async function runSegments(): Promise<void> {
    if (!state) return
    const pending = state.segments.filter(
      (segment) => segment.loaded < segmentLength(segment),
    )
    if (pending.length === 0) return
    const results = await Promise.allSettled(
      pending.map((segment) => downloadSegment(segment)),
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (fatalError) throw fatalError
    if (rejected) throw rejected.reason
  }

  async function start(): Promise<TransferOutcome> {
    if (stopRequested) return { status: 'paused' }
    if (running) return { status: 'failed', error: new Error('传输已在进行中') }
    running = true
    donePromise = new Promise<void>((resolve) => { doneResolve = resolve })

    try {
      // 上次已经完整落盘、只是没来得及改名：有 SHA1 时可以直接校验；
      // 没有 SHA1 时不能相信文件长度——分段实现会预分配 `.part` 到总长度，
      // 长度等于总大小并不代表所有字节都来自网络。
      if (
        options.size > 0
        && fileSize(options.partPath) === options.size
        && !existsSync(statePath)
      ) {
        if (options.sha1) {
          const digest = await hashFile(options.partPath)
          if (digest === options.sha1.toLowerCase()) return { status: 'done', digest }
        }
        await rm(options.partPath, { force: true }).catch(() => undefined)
      }

      let probe: RangeProbe | null = null
      try {
        probe = await probeRange()
      } catch (cause) {
        if (stopRequested) throw cause
        probe = null
      }
      if (!probe) return await fallback('服务端不支持分段下载')

      totalSize = probe.total
      const restored = await loadState(probe)
      if (restored) {
        state = restored
      } else {
        state = createState(probe)
        if (!state) return await fallback('文件太小，改用单连接')
        await rm(options.partPath, { force: true }).catch(() => undefined)
        await rm(statePath, { force: true }).catch(() => undefined)
      }

      // 先写元数据再预分配：即使进程在 truncate 后立刻退出，下次也能
      // 通过状态文件知道每段的真实进度，而不是把预分配的长度当成已完成。
      await persist(true)
      await preparePart()
      if (stopRequested) return { status: 'paused' }
      report(true)
      if (allDone()) return await finish()

      await runSegments()
      if (stopRequested) {
        await flushState()
        return { status: 'paused' }
      }
      return await finish()
    } catch (cause) {
      if (stopRequested) {
        await flushState()
        return { status: 'paused' }
      }
      const error = toError(cause)
      if (error instanceof RangeUnsupportedError) {
        return await fallback(error.message)
      }
      await flushState()
      return { status: 'failed', error }
    } finally {
      running = false
      doneResolve?.()
      doneResolve = null
      abortAll()
    }
  }

  async function stop(): Promise<void> {
    stopRequested = true
    abortAll()
    void fallbackHandle?.stop().catch(() => undefined)
    if (running) await donePromise
    if (state) await flushState()
  }

  return { start, stop }
}
