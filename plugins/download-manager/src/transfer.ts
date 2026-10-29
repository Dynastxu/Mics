import { createHash, type Hash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import type { Agent as HttpAgent } from 'node:http'
import type { Agent as HttpsAgent } from 'node:https'
import { DownloaderHelper } from 'node-downloader-helper'
import type {
  FileTransferHandle,
  FileTransferSpec,
  TransferOutcome,
  TransferProgress,
} from '@mics/sdk'

/**
 * 单文件传输层的本机实现（`mics.net.file-transfer` 的默认 provider）。
 *
 * 把「断点续传、Range、重定向、重试」交给 node-downloader-helper，
 * 下载管线只关心任务编排（多源、并发、校验、缓存）。
 *
 * 约定：文件先写到 `<目标>.part`，成功后由调用方改名；
 * 暂停/失败都保留 .part，下次从已有字节续传。
 *
 * 本文件只实现 `FileTransferCapability.create`，能力契约在 SDK 里：
 * 换成沙箱 / 远程 provider 时，这段代码整体被替换，调用方不变。
 */

export interface TransferAgents {
  http: HttpAgent
  https: HttpsAgent
}

/** 本机实现需要的 agent 是具体类型，契约里只声明「透传」 */
export interface FileTransferOptions extends FileTransferSpec {
  agents: TransferAgents
}

export type { TransferOutcome, TransferProgress }

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

async function hashRange(file: string, length: number, hash: Hash): Promise<void> {
  if (length <= 0) return
  const stream = createReadStream(file, { start: 0, end: length - 1 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
}

export function createFileTransfer(options: FileTransferOptions): FileTransferHandle {
  let helper: DownloaderHelper | null = null
  let stopRequested = false
  let ended: { incomplete: boolean } | null = null
  let hash: Hash | null = options.sha1 ? createHash('sha1') : null

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash?.update(chunk as Buffer)
      callback(null, chunk)
    },
  })

  async function start(): Promise<TransferOutcome> {
    const partSize = fileSize(options.partPath)

    // 上次已经写完但没来得及改名：直接校验，不必再发请求
    if (options.size > 0 && partSize === options.size) {
      if (!hash) return { status: 'done' }
      await hashRange(options.partPath, partSize, hash)
      return { status: 'done', digest: hash.digest('hex') }
    }

    let resuming = partSize > 0
    if (resuming && options.size <= 0) {
      // 总大小未知时无法判断 .part 是否完整，续传风险太大，直接重来
      await rm(options.partPath, { force: true }).catch(() => undefined)
      resuming = false
    } else if (resuming && partSize > options.size) {
      // 比目标文件还大，只能是损坏的残留，重来
      await rm(options.partPath, { force: true }).catch(() => undefined)
      resuming = false
    }

    if (resuming && hash) {
      // 续传时先补上已有字节的摘要，再让库接着写
      await hashRange(options.partPath, partSize, hash)
    }

    if (stopRequested) return { status: 'paused' }

    helper = new DownloaderHelper(options.url, path.dirname(options.partPath), {
      fileName: path.basename(options.partPath),
      override: true,
      removeOnStop: false,
      removeOnFail: false,
      resumeOnIncomplete: true,
      resumeOnIncompleteMaxRetry: 3,
      timeout: 15_000,
      progressThrottle: 500,
      httpRequestOptions: { agent: options.agents.http },
      httpsRequestOptions: { agent: options.agents.https },
    })

    // EventEmitter 如果没有 error 监听会在 emit 时抛异常；错误统一走 start() 的 reject
    helper.on('error', () => undefined)
    helper.on('warning', () => undefined)
    helper.on('download', (info) => {
      if (!info.isResumed) {
        // 服务端忽略了 Range：文件已被清空，摘要与进度都要从头开始
        hash = options.sha1 ? createHash('sha1') : null
        options.onRestart?.()
      }
      options.onProgress?.({ loaded: info.downloadedSize, total: info.totalSize ?? -1 })
    })
    helper.on('progress.throttled', (stats) => {
      options.onProgress?.({ loaded: stats.downloaded, total: stats.total ?? -1 })
    })
    helper.on('end', (info) => {
      ended = info
    })
    helper.pipe(tap)

    // 极短窗口内被暂停：此时 stop() 可能早于 start()，不能再发起请求
    if (stopRequested) {
      await helper.stop().catch(() => undefined)
      return { status: 'paused' }
    }

    try {
      if (resuming) {
        await helper.resumeFromFile(options.partPath, {
          downloaded: partSize,
          fileName: path.basename(options.partPath),
          ...(options.size > 0 ? { total: options.size } : {}),
        })
      } else {
        await helper.start()
      }
    } catch (cause) {
      if (stopRequested) return { status: 'paused' }
      return { status: 'failed', error: toError(cause) }
    }

    if (stopRequested) return { status: 'paused' }
    if (ended?.incomplete) {
      return { status: 'failed', error: new Error('下载未完成') }
    }
    return { status: 'done', digest: hash ? hash.digest('hex') : undefined }
  }

  async function stop(): Promise<void> {
    stopRequested = true
    if (!helper) return
    await helper.stop().catch(() => undefined)
  }

  return { start, stop }
}
