import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
  FILE_TRANSFER,
  normalizeDownloadSources,
  validateInstanceName,
} from '@mics/sdk'
import type {
  DownloadSource,
  DownloadTask,
  FileTransferCapability,
  FileTransferHandle,
  InstallJob,
  InstanceNameCheck,
  InstallRequest,
  TransferOutcome,
} from '@mics/sdk'
import { createFileTransfer, type FileTransferOptions } from './transfer'

let taskSeq = 0
let jobSeq = 0

function maxSequence(ids: Iterable<string>, prefix: string): number {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const value = Number(id.slice(prefix.length))
    if (Number.isInteger(value)) max = Math.max(max, value)
  }
  return max
}

interface StoredRecords {
  jobs: InstallJob[]
  tasks: DownloadTask[]
}

interface MojangArtifact {
  url: string
  sha1: string
  size: number
  path?: string
}

interface MojangLibrary {
  name: string
  downloads: {
    artifact?: MojangArtifact
    classifiers?: Record<string, MojangArtifact>
  }
  natives?: Record<string, string>
}

interface MojangLoggingClient {
  argument: string
  file: { id: string; sha1: string; size: number; url: string }
  type: string
}

interface MojangVersionDetail {
  id: string
  mainClass: string
  arguments?: { game: unknown[]; jvm: unknown[] }
  downloads: {
    client?: MojangArtifact
    server?: MojangArtifact
  }
  libraries: MojangLibrary[]
  assetIndex: { url: string; sha1: string; size: number; id: string; totalSize: number }
  assets: string
  logging?: { client: MojangLoggingClient }
}

interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
}

interface TaskSpec {
  label: string
  url: string
  savePath: string
  sha1: string
  size: number
}

interface MojangManifestSummary {
  latest: { release: string; snapshot: string }
  versions: Array<{ id: string; type: string; releaseTime: string; url: string }>
}

/** 元数据请求的总时长上限；并行请求下它只兜底「所有源都挂住」的情况 */
const METADATA_TIMEOUT = 20_000

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function remapUrl(url: string, src: DownloadSource): string {
  return url
    .replace('launchermeta.mojang.com', src.launchermeta)
    .replace('libraries.minecraft.net', src.libraries)
    .replace('resources.download.minecraft.net', src.resources)
}

export const name = 'mics.download.manager'
export const inject = ['ipc', 'storage', 'capabilities']

export function apply(ctx: Context): void {
  const tasks = new Map<string, DownloadTask>()
  const jobs = new Map<string, InstallJob>()
  /** 正在传输的任务句柄：暂停/取消时用它中断请求（.part 保留） */
  const transfers = new Map<string, FileTransferHandle>()
  /** 每个任务当前下载轮次；暂停后立刻恢复时靠它丢弃上一轮的迟到回调 */
  const downloadRuns = new Map<string, number>()
  const cancelledTasks = new Set<string>()
  const cancelledJobs = new Set<string>()
  /** 整体暂停的安装任务：调度器与下载循环据此判断是否还能继续 */
  const pausedJobs = new Set<string>()
  /** 准备阶段的请求控制器，取消安装时可以立即中断元数据请求 */
  const prepAborts = new Map<string, AbortController>()

  const dataDir = app.getPath('userData')
  const cacheRoot = path.join(dataDir, 'cache', 'downloads')
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 })

  // 默认的传输实现由本插件提供，但调用方只依赖能力名：沙箱 / 镜像插件可以用
  // 更高的 priority 注册同名能力整体替换，下载管线不需要改。
  ctx.capabilities.provide<FileTransferCapability>(FILE_TRANSFER, {
    label: 'local',
    create: (spec) => createFileTransfer(spec as FileTransferOptions),
  })

  /** 已受理但尚未落盘的实例名：并发提交同名安装时先占位 */
  const reservedInstanceNames = new Set<string>()

  /** Windows 文件名不区分大小写，重名判断也要一致 */
  function instanceKey(name: string): string {
    return process.platform === 'win32' ? name.toLowerCase() : name
  }

  function instanceDirOf(name: string): string {
    return path.join(dataDir, 'instances', name)
  }

  /**
   * 实例名是否可用：先按共享规则校验名称本身，再检查目录是否已被占用。
   * 渲染进程的即时提示与安装入口共用这一处判断，避免两边结论不一致。
   */
  function checkInstanceName(raw: string): InstanceNameCheck {
    const base = validateInstanceName(raw)
    if (!base.ok) return base

    if (existsSync(instanceDirOf(base.name))) {
      return {
        ok: false,
        name: base.name,
        issue: 'duplicate',
        message: `实例「${base.name}」已存在，请换一个名称`,
      }
    }

    if (reservedInstanceNames.has(instanceKey(base.name))) {
      return {
        ok: false,
        name: base.name,
        issue: 'duplicate',
        message: `实例「${base.name}」正在安装，请换一个名称`,
      }
    }

    return base
  }

  let cachedManifest: MojangManifestSummary | null = null
  let cachedAt = 0
  const CACHE_TTL = 5 * 60 * 1000

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let recordsDirty = false

  type SourceCategory = 'meta' | 'libraries' | 'assets' | 'other'
  interface SourceHealth {
    failures: number
    disabledUntil: number
  }

  const SOURCE_FAILURE_LIMIT = 3
  const SOURCE_COOLDOWN = 5 * 60 * 1000
  const sourceHealth = new Map<string, SourceHealth>()

  function sourceCategory(url: string): SourceCategory {
    if (url.includes('resources.download.minecraft.net')) return 'assets'
    if (url.includes('libraries.minecraft.net')) return 'libraries'
    if (url.includes('launchermeta.mojang.com')) return 'meta'
    return 'other'
  }

  function healthKey(sourceIndex: number, category: SourceCategory): string {
    return `${sourceIndex}:${category}`
  }

  function sourceAvailable(sourceIndex: number, category: SourceCategory): boolean {
    const key = healthKey(sourceIndex, category)
    const health = sourceHealth.get(key)
    if (!health?.disabledUntil) return true
    if (health.disabledUntil > Date.now()) return false
    sourceHealth.delete(key)
    return true
  }

  function reportSource(sourceIndex: number, category: SourceCategory, success: boolean): void {
    const key = healthKey(sourceIndex, category)
    if (success) {
      const health = sourceHealth.get(key)
      if (health && !health.disabledUntil) sourceHealth.delete(key)
      return
    }

    const health = sourceHealth.get(key) ?? { failures: 0, disabledUntil: 0 }
    health.failures += 1
    if (health.failures >= SOURCE_FAILURE_LIMIT) {
      health.failures = 0
      health.disabledUntil = Date.now() + SOURCE_COOLDOWN
    }
    sourceHealth.set(key, health)
  }

  function loadSources(): DownloadSource[] {
    try {
      const raw = ctx.storage.get<string>('sources', '')
      if (raw) return normalizeDownloadSources(JSON.parse(raw))
    } catch { /* fall through */ }
    return normalizeDownloadSources(DEFAULT_DOWNLOAD_SOURCES)
  }

  /** 参与下载的源下标（保持优先级顺序） */
  function enabledSourceIndexes(sources: DownloadSource[]): number[] {
    const indexes: number[] = []
    for (let index = 0; index < sources.length; index++) {
      if (sources[index]?.enabled !== false) indexes.push(index)
    }
    return indexes
  }

  function cachePath(sha1: string): string {
    return path.join(cacheRoot, sha1.slice(0, 2), sha1.slice(2))
  }

  const maxConcurrency = () => {
    const fallback = Number(DEFAULT_DOWNLOAD_CONCURRENCY) || 64
    const raw = ctx.storage.get<string>('concurrency', DEFAULT_DOWNLOAD_CONCURRENCY)
    return Math.max(1, Math.min(128, Number(raw) || fallback))
  }

  function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /** .part 已落盘的字节数；文件不存在时为 0 */
  function partSizeOf(savePath: string): number {
    try {
      return statSync(savePath + '.part').size
    } catch {
      return 0
    }
  }

  function flushRecords(): void {
    recordsDirty = false
    try {
      ctx.storage.set('records', {
        jobs: [...jobs.values()],
        tasks: [...tasks.values()],
      } satisfies StoredRecords)
    } catch { /* 退出或存储不可用时忽略，避免阻塞关闭 */ }
  }

  function persistRecords(immediate = false): void {
    recordsDirty = true
    if (immediate) {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      flushRecords()
      return
    }
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (recordsDirty) flushRecords()
    }, 1000)
  }

  function loadRecords(): void {
    const raw = ctx.storage.get<StoredRecords>('records')
    if (!raw || !Array.isArray(raw.jobs) || !Array.isArray(raw.tasks)) return

    for (const value of raw.jobs) {
      const job = value as InstallJob
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.taskIds)) continue
      job.taskIds = job.taskIds.filter((id): id is string => typeof id === 'string')
      // 旧记录没有 state；上次退出时还在准备阶段的安装无法续上，明确标为失败
      if (job.state === 'preparing') {
        job.state = 'failed'
        job.error = '应用退出时仍在准备下载清单'
      } else if (!job.state) {
        job.state = 'ready'
      }
      jobs.set(job.id, job)
    }

    for (const value of raw.tasks) {
      const task = value as DownloadTask
      if (!task || typeof task.id !== 'string' || typeof task.installId !== 'string') continue
      if (!jobs.has(task.installId) || !task.progress || typeof task.progress !== 'object') continue

      if (task.state !== 'done' && task.state !== 'failed') {
        // 上次退出时还在队列/下载/校验中的任务，重启后以暂停状态等待恢复。
        task.state = 'paused'
        task.progress.speed = 0
        // 进度以 .part 的实际大小为准，恢复时就从这个字节位置续传
        task.progress.loaded = partSizeOf(task.savePath)
        if (task.progress.total <= 0) {
          task.progress.total = task.size > 0 ? task.size : -1
        }
      } else if (task.state === 'done' && task.progress.loaded === 0 && task.size > 0) {
        task.progress.loaded = task.size
      }

      tasks.set(task.id, task)
    }

    for (const job of jobs.values()) {
      job.taskIds = job.taskIds.filter((id) => tasks.has(id))
    }

    taskSeq = Math.max(taskSeq, maxSequence(tasks.keys(), 'task_'))
    jobSeq = Math.max(jobSeq, maxSequence(jobs.keys(), 'job_'))

    if (jobs.size > 0 || raw.jobs.length > 0) persistRecords(true)
  }

  const flushOnQuit = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (recordsDirty) flushRecords()
  }
  app.on('before-quit', flushOnQuit)
  ctx.effect(() => () => {
    app.off('before-quit', flushOnQuit)
    httpAgent.destroy()
    httpsAgent.destroy()
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (recordsDirty) flushRecords()
  })

  /** 元数据 JSON 请求：跟随重定向，复用 keep-alive 连接 */
  function requestJson(url: string, signal: AbortSignal, redirects = 0): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (redirects > 8) {
        reject(new Error('重定向次数过多'))
        return
      }
      const secure = url.startsWith('https')
      const proto = secure ? https : http
      const req = proto.get(url, {
        signal,
        agent: secure ? httpsAgent : httpAgent,
      }, (res) => {
        const status = res.statusCode ?? 0

        if (status >= 300 && status < 400) {
          res.resume()
          const location = res.headers.location
          if (!location) {
            reject(new Error(`HTTP ${status}`))
            return
          }
          let next: string
          try {
            next = new URL(location, url).toString()
          } catch {
            reject(new Error(`无效的重定向地址：${location}`))
            return
          }
          requestJson(next, signal, redirects + 1).then(resolve, reject)
          return
        }

        if (status >= 400) {
          res.resume()
          reject(new Error(`HTTP ${status} from ${url}`))
          return
        }

        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch (error) { reject(error) }
        })
        res.on('error', reject)
      })

      req.setTimeout(10_000, () => req.destroy(new Error('请求超时')))
      req.on('error', reject)
    })
  }

  /**
   * 在所有启用的下载源上并行请求同一份元数据，最先成功的返回。
   *
   * 串行重试时，一个不可达的源会把「点击安装」拖住整整一个超时周期；
   * 并行后慢源不再影响结果，取消安装时也能立刻中断所有请求。
   */
  async function fetchJsonFromSources(url: string, signal?: AbortSignal): Promise<unknown> {
    const sources = loadSources()
    const enabled = enabledSourceIndexes(sources)
    if (enabled.length === 0) throw new Error('未启用任何下载源')

    // 多个源可能映射到同一个地址，去重后只请求一次
    const targets = [
      ...new Set(enabled.map((index) => remapUrl(url, sources[index]!))),
    ]

    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }

    const attempts = targets.map((target) => {
      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`请求超时：${target}`)), METADATA_TIMEOUT)
        controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
      })
      return Promise.race([requestJson(target, controller.signal), timeout])
    })

    try {
      return await Promise.any(attempts)
    } catch (cause) {
      if (cause instanceof AggregateError) {
        const reasons = cause.errors.map(toError)
        throw reasons.find((reason) => reason.name !== 'AbortError')
          ?? reasons[0]
          ?? new Error('所有下载源均不可用')
      }
      throw toError(cause)
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      controller.abort()
    }
  }

  async function fetchMojangManifest(signal?: AbortSignal): Promise<MojangManifestSummary> {
    if (cachedManifest && Date.now() - cachedAt < CACHE_TTL) {
      return cachedManifest
    }
    const data = (await fetchJsonFromSources(
      'https://launchermeta.mojang.com/mc/game/version_manifest.json',
      signal,
    )) as MojangManifestSummary
    cachedManifest = data
    cachedAt = Date.now()
    return data
  }

  async function fetchVersionDetail(version: string, signal?: AbortSignal): Promise<MojangVersionDetail> {
    const manifest = await fetchMojangManifest(signal)
    const entry = manifest.versions.find((v) => v.id === version)
    if (!entry) throw new Error(`未找到版本 ${version}`)
    return (await fetchJsonFromSources(entry.url, signal)) as MojangVersionDetail
  }

  function scheduleLoop(): void {
    const active = [...tasks.values()].filter((t) => t.state === 'downloading').length
    const slots = maxConcurrency() - active
    if (slots <= 0) return
    const pending = [...tasks.values()].filter(
      (task) => task.state === 'pending' && !pausedJobs.has(task.installId),
    )
    for (const task of pending.slice(0, slots)) {
      void startDownload(task)
    }
  }

  async function dropCancelled(task: DownloadTask, ...files: string[]): Promise<boolean> {
    if (!cancelledTasks.has(task.id)) return false
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    for (const file of files) {
      await rm(file, { force: true }).catch(() => undefined)
    }
    return true
  }

  async function startDownload(task: DownloadTask): Promise<void> {
    if (
      cancelledTasks.has(task.id)
      || pausedJobs.has(task.installId)
      || task.state !== 'pending'
    ) {
      return
    }

    // 暂停后马上恢复时，上一轮下载可能还没退出；用代号确保只有最新一轮能改状态
    const run = (downloadRuns.get(task.id) ?? 0) + 1
    downloadRuns.set(task.id, run)
    const current = (): boolean => downloadRuns.get(task.id) === run

    task.state = 'downloading'
    task.progress.speed = 0
    const partPath = task.savePath + '.part'
    const pausedNow = (): boolean => pausedJobs.has(task.installId) || task.state === 'paused'

    /** 进入暂停态；.part 保留，恢复时从已有字节续传 */
    const settlePaused = (): void => {
      if (!current()) return
      task.state = 'paused'
      task.progress.speed = 0
      persistRecords()
    }

    // 命中缓存的文件直接复制，不再阻塞安装提交（提交只负责建任务）
    if (task.sha1) {
      try {
        if (await tryCopyFromCache(task)) {
          if (!current()) return
          if (await dropCancelled(task, task.savePath)) return
          if (pausedNow()) {
            settlePaused()
            return
          }
          if (task.size > 0) {
            task.progress.loaded = task.size
            task.progress.total = task.size
          }
          task.state = 'done'
          persistRecords()
          scheduleLoop()
          return
        }
      } catch { /* 缓存不可用时退回网络下载 */ }
    }
    if (!current()) return

    const sources = loadSources()
    const category = sourceCategory(task.url)
    const enabled = enabledSourceIndexes(sources)
    if (enabled.length === 0) {
      task.state = 'failed'
      task.error = '所有下载源均已禁用'
      task.progress.speed = 0
      persistRecords()
      scheduleLoop()
      return
    }
    const preferred = enabled.filter((index) => sourceAvailable(index, category))
    const order = preferred.length > 0 ? preferred : enabled

    try {
      ensureDir(path.dirname(task.savePath))
    } catch (cause) {
      task.state = 'failed'
      task.error = `无法创建下载目录：${toError(cause).message}`
      persistRecords()
      scheduleLoop()
      return
    }

    for (let ci = 0; ci < order.length; ci++) {
      const si = order[ci]
      if (si === undefined) continue
      const src = sources[si]
      if (!src) continue

      if (!current()) return
      if (await dropCancelled(task, partPath)) return
      if (pausedNow()) {
        settlePaused()
        return
      }

      const transfer = ctx.capabilities.require<FileTransferCapability>(FILE_TRANSFER).create({
        url: remapUrl(task.url, src),
        partPath,
        sha1: task.sha1,
        size: task.size > 0 ? task.size : 0,
        agents: { http: httpAgent, https: httpsAgent },
        onProgress: ({ loaded, total }) => {
          if (!current()) return
          task.progress.loaded = loaded
          if (total > 0) {
            task.progress.total = total
            if (task.size <= 0) task.size = total
          }
        },
        onRestart: () => {
          if (current()) task.progress.loaded = 0
        },
      })
      transfers.set(task.id, transfer)

      let result: TransferOutcome
      try {
        result = await transfer.start()
      } catch (cause) {
        // 传输层自身异常也要走「换源/失败」流程，不能让 Promise 无人处理
        result = {
          status: 'failed',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }
      } finally {
        // 恢复可能已经创建了新一轮传输，不能误删别人的句柄
        if (transfers.get(task.id) === transfer) transfers.delete(task.id)
      }

      if (!current()) return
      if (await dropCancelled(task, partPath, task.savePath)) return

      if (result.status === 'paused') {
        settlePaused()
        return
      }

      if (result.status === 'failed') {
        // 暂停引发的请求中断在底层可能表现为失败，以任务状态为准
        if (pausedNow()) {
          settlePaused()
          return
        }
        reportSource(si, category, false)
        if (ci < order.length - 1) continue
        task.state = 'failed'
        task.error = result.error?.message ?? '下载失败'
        persistRecords()
        scheduleLoop()
        return
      }

      // done：先校验，再改名并写入缓存
      if (task.sha1) {
        task.state = 'verifying'
        if (result.digest !== task.sha1) {
          // 分片来自损坏的镜像或残留文件，删掉后从下一个源重新开始
          await rm(partPath, { force: true }).catch(() => undefined)
          reportSource(si, category, false)
          if (ci < order.length - 1) continue
          task.state = 'failed'
          task.error = `SHA1 校验失败：期望 ${task.sha1}，实际 ${result.digest ?? '未知'}`
          persistRecords()
          scheduleLoop()
          return
        }
      }

      if (await dropCancelled(task, partPath)) return

      try {
        await rename(partPath, task.savePath)
      } catch (cause) {
        task.state = 'failed'
        task.error = `无法写入目标文件：${toError(cause).message}`
        persistRecords()
        scheduleLoop()
        return
      }

      if (await dropCancelled(task, task.savePath)) return

      if (task.sha1) {
        const cached = cachePath(task.sha1)
        if (!existsSync(cached)) {
          try {
            ensureDir(path.dirname(cached))
            await copyFile(task.savePath, cached)
          } catch { /* 缓存只是加速手段，写不进去不影响本次安装 */ }
        }
      }

      if (!current()) return
      if (await dropCancelled(task, task.savePath)) return

      reportSource(si, category, true)
      if (task.size > 0) {
        task.progress.loaded = task.size
        task.progress.total = task.size
      }
      task.progress.speed = 0
      task.state = 'done'
      persistRecords()
      scheduleLoop()
      return
    }
  }

  /** 单个任务暂停：未开始与下载中的任务都可以暂停；.part 保留以便续传 */
  function pauseTask(taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) return Promise.resolve()
    if (task.state !== 'pending' && task.state !== 'downloading') return Promise.resolve()
    task.state = 'paused'
    task.progress.speed = 0
    const transfer = transfers.get(taskId)
    return transfer ? transfer.stop().catch(() => undefined) : Promise.resolve()
  }

  /** 单个任务恢复：从 .part 继续，首次进度回调会按文件实际大小校正 */
  function resumeTask(taskId: string): void {
    const task = tasks.get(taskId)
    if (!task || task.state !== 'paused') return
    task.state = 'pending'
    task.progress.speed = 0
  }

  async function cancelTask(taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task || task.state === 'done' || task.state === 'failed') return
    cancelledTasks.add(taskId)
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    const transfer = transfers.get(taskId)
    if (transfer) await transfer.stop().catch(() => undefined)
    await rm(task.savePath + '.part', { force: true }).catch(() => undefined)
  }

  function nextTaskId(): string {
    taskSeq += 1
    return `task_${taskSeq}`
  }

  function nextJobId(): string {
    jobSeq += 1
    return `job_${jobSeq}`
  }

  async function tryCopyFromCache(task: Pick<DownloadTask, 'sha1' | 'savePath'>): Promise<boolean> {
    if (!task.sha1) return false
    const cached = cachePath(task.sha1)
    if (!existsSync(cached)) return false
    ensureDir(path.dirname(task.savePath))
    await copyFile(cached, task.savePath)
    return true
  }

  /**
   * 后台准备安装：拉版本详情、资源索引与清单，再登记下载任务。
   *
   * 它不阻塞 `install/start`：界面可以先跳到下载页，任务就绪后自动出现。
   * 失败或取消时把刚创建的实例目录清掉，避免留下无法重装的空实例。
   */
  async function prepareJob(job: InstallJob, request: InstallRequest): Promise<void> {
    const instanceDir = instanceDirOf(job.instanceName)
    const nameKey = instanceKey(job.instanceName)
    const abort = new AbortController()
    prepAborts.set(job.id, abort)
    const isCancelled = (): boolean => cancelledJobs.has(job.id)
    let createdInstance = false

    try {
      const detail = await fetchVersionDetail(request.gameVersion, abort.signal)
      if (isCancelled()) return

      const versionsDir = path.join(instanceDir, 'versions', request.gameVersion)

      // 1. version.json（实例目录从这一步开始存在）
      createdInstance = true
      ensureDir(versionsDir)
      await writeFile(
        path.join(versionsDir, `${request.gameVersion}.json`),
        JSON.stringify(detail, null, 2),
      )

      const taskSpecs: TaskSpec[] = []

      // 2. client.jar
      if (detail.downloads?.client) {
        const d = detail.downloads.client
        taskSpecs.push({
          label: `client.jar (${request.gameVersion})`,
          url: d.url,
          savePath: path.join(versionsDir, `${request.gameVersion}.jar`),
          sha1: d.sha1,
          size: d.size,
        })
      }

      // 3. Libraries（常规 + native classifiers）
      for (const lib of detail.libraries ?? []) {
        const artifacts: MojangArtifact[] = []
        if (lib.downloads?.artifact) artifacts.push(lib.downloads.artifact)

        if (lib.downloads?.classifiers) {
          for (const [classifier, art] of Object.entries(lib.downloads.classifiers)) {
            const os = classifier.replace('natives-', '')
            if (os === 'windows' || os.startsWith('natives-windows')) {
              artifacts.push(art)
            }
          }
        }

        for (const art of artifacts) {
          const libParts = lib.name.split(':')
          const libFile = libParts.length >= 3
            ? `${libParts[1]}-${libParts[2]}${art.url.includes('natives') ? '-' + (art.url.match(/natives-[^/]+/)?.[0] ?? '') : ''}.jar`
            : `${lib.name.replace(/:/g, '/')}.jar`
          const libDir = libParts.length >= 3
            ? path.join(libParts[0]!.replace(/\./g, '/'), libParts[1]!, libParts[2]!)
            : path.dirname(lib.name.replace(/:/g, '/'))
          const relative = art.path ?? path.join(libDir, libFile)

          taskSpecs.push({
            label: lib.name,
            url: art.url,
            savePath: path.join(versionsDir, 'libraries', relative),
            sha1: art.sha1 ?? '',
            size: art.size ?? 0,
          })
        }
      }

      // 4. Asset index + objects
      if (detail.assetIndex?.url) {
        const rawIndex = (await fetchJsonFromSources(
          detail.assetIndex.url,
          abort.signal,
        )) as AssetIndex
        if (isCancelled()) return
        const objects = rawIndex.objects ?? {}

        const assetDir = path.join(versionsDir, 'assets')
        const indexPath = path.join(assetDir, 'indexes', `${detail.assets ?? request.gameVersion}.json`)
        ensureDir(path.dirname(indexPath))
        await writeFile(indexPath, JSON.stringify(rawIndex, null, 2))

        for (const [, obj] of Object.entries(objects)) {
          const hash2 = obj.hash.slice(0, 2)
          taskSpecs.push({
            label: `asset ${obj.hash.slice(0, 12)}…`,
            url: `https://resources.download.minecraft.net/${hash2}/${obj.hash}`,
            savePath: path.join(assetDir, 'objects', hash2, obj.hash),
            sha1: obj.hash,
            size: obj.size,
          })
        }
      }

      // 5. Logging config
      if (detail.logging?.client?.file) {
        const lf = detail.logging.client.file
        taskSpecs.push({
          label: `logging config (${lf.id})`,
          url: lf.url,
          savePath: path.join(versionsDir, 'log_configs', lf.id),
          sha1: lf.sha1,
          size: lf.size,
        })
      }

      if (isCancelled()) return

      // 任务先全部登记（缓存命中由下载循环判断），提交因此始终是常数级耗时
      const paused = pausedJobs.has(job.id)
      for (const spec of taskSpecs) {
        const task: DownloadTask = {
          id: nextTaskId(),
          installId: job.id,
          url: spec.url,
          savePath: spec.savePath,
          sha1: spec.sha1,
          size: spec.size,
          label: spec.label,
          state: paused ? 'paused' : 'pending',
          progress: {
            loaded: 0,
            total: spec.size > 0 ? spec.size : -1,
            speed: 0,
            label: spec.label,
          },
          createdAt: Date.now(),
        }
        tasks.set(task.id, task)
        job.taskIds.push(task.id)
      }

      job.state = 'ready'
      persistRecords(true)
      if (!paused) scheduleLoop()
    } catch (cause) {
      if (isCancelled()) return
      job.state = 'failed'
      job.error = toError(cause).message
    } finally {
      prepAborts.delete(job.id)
      if (isCancelled()) job.state = 'cancelled'
      if (job.state === 'failed' || job.state === 'cancelled') {
        pausedJobs.delete(job.id)
        // 先清掉半成品目录再释放名称，否则重试会被残留的目录判成重名
        if (createdInstance) {
          await rm(instanceDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      // 版本目录此时已落盘；后续重名判断交给目录检查
      reservedInstanceNames.delete(nameKey)
      persistRecords(true)
    }
  }

  loadRecords()

  // ── IPC handlers ──

  ctx.ipc.handle('settings/get', () => ({
    concurrency: String(maxConcurrency()),
    cacheDir: ctx.storage.get<string>('cacheDir', ''),
    cacheLimit: ctx.storage.get<string>('cacheLimit', DEFAULT_DOWNLOAD_CACHE_LIMIT),
    sources: loadSources(),
  }))

  ctx.ipc.handle<{ key: string; value: string }>('settings/set', ({ key, value }) => {
    if (key === 'sources') {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { parsed = null }
      ctx.storage.set(key, JSON.stringify(normalizeDownloadSources(parsed)))
      sourceHealth.clear()
      return
    }
    ctx.storage.set(key, value)
  })

  ctx.ipc.handle('tasks/list', () => [...tasks.values()])

  ctx.ipc.handle<{ taskId: string }>('tasks/cancel', async ({ taskId }) => {
    await cancelTask(taskId)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/pause', async ({ taskId }) => {
    await pauseTask(taskId)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/resume', ({ taskId }) => {
    resumeTask(taskId)
    persistRecords(true)
    scheduleLoop()
  })

  ctx.ipc.handle('install/list', () => [...jobs.values()])

  ctx.ipc.handle<{ jobId: string }>('install/cancel', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    // 已完成的安装不能被取消改写历史
    const unfinished = job.state === 'preparing' || job.taskIds.some((taskId) => {
      const task = tasks.get(taskId)
      return task !== undefined && task.state !== 'done' && task.state !== 'failed'
    })
    if (!unfinished) return
    cancelledJobs.add(jobId)
    pausedJobs.delete(jobId)
    job.state = 'cancelled'
    // 准备阶段的安装没有任务，中断元数据请求后由 prepareJob 负责清理实例目录
    prepAborts.get(jobId)?.abort()
    await Promise.all(job.taskIds.map((taskId) => cancelTask(taskId)))
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/pause', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'failed' || job.state === 'cancelled') return
    // 任务级状态负责展示，任务级暂停集体生效；未开始的任务也要一起停下
    pausedJobs.add(jobId)
    await Promise.all(job.taskIds.map((taskId) => pauseTask(taskId)))
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/resume', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'failed' || job.state === 'cancelled') return
    pausedJobs.delete(jobId)
    for (const taskId of job.taskIds) resumeTask(taskId)
    persistRecords(true)
    scheduleLoop()
  })

  ctx.ipc.handle<{ name: string }>('install/validate-name', ({ name }) => checkInstanceName(name))

  ctx.ipc.handle<InstallRequest>('install/start', (request) => {
    const check = checkInstanceName(request.instanceName)
    if (!check.ok) return { jobId: '', error: check.message ?? '实例名称无效' }

    const instanceName = check.name
    const job: InstallJob = {
      id: nextJobId(),
      instanceName,
      gameVersion: request.gameVersion,
      loader: request.loader,
      taskIds: [],
      createdAt: Date.now(),
      state: 'preparing',
    }
    jobs.set(job.id, job)

    // 从受理到版本目录落盘之间占住名称，避免同一名称的并发安装互相覆盖
    reservedInstanceNames.add(instanceKey(instanceName))
    // 不做同步落盘：任务列表可能有上千条，写入会拖慢「点击即返回」的受理路径
    persistRecords()

    // 立刻返回：下载清单在后台准备，调用方直接跳转到下载页
    void prepareJob(job, request).catch(() => undefined)

    return { jobId: job.id }
  })
}

export default defineMainPlugin({ name, inject, apply })