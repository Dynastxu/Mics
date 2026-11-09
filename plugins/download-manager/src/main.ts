import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { copyFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import type { Context } from 'cordis'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SEGMENTS,
  DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD,
  DOWNLOAD_CACHE_LIMIT_OFF,
  DOWNLOAD_CACHE_LIMIT_UNLIMITED,
  FILE_TRANSFER,
  downloadCacheLimitBytes,
  micsUserAgent,
  normalizeDownloadCacheLimit,
  normalizeDownloadSegmentThreshold,
  normalizeDownloadSegments,
  normalizeDownloadSources,
  normalizeLoaderSources,
  normalizeModSources,
  parseDownloadCacheLimit,
  parseDownloadSegmentThresholdMb,
  parseDownloadSegments,
  serialEvent
} from '@mics/sdk'
import type {
  DownloadAddFilesRequest,
  DownloadAddFilesResult,
  DownloadAwaitRequest,
  DownloadEndpoint,
  DownloadFileRequest,
  DownloadFileResult,
  DownloadFinishRequest,
  DownloadJobHandle,
  DownloadJobRequest,
  DownloadJobResult,
  DownloadJobState,
  DownloadReportPatch,
  DownloadTaskState,
  DownloadTaskView,
  FileTransferCapability,
  FileTransferHandle,
  InstallJobKind,
  InstallJobStats,
  InstallJobSummary,
  InstallLiveState,
  InstanceInstallStatus,
  LegacyDownloadConfig,
  TransferOutcome,
  TransferProgress
} from '@mics/sdk'
import {
  createFileTransfer,
  transferStatePath,
  transferStateProgress,
  type FileTransferOptions
} from './transfer'
import { defineMainPlugin, isReadableJar } from '@mics/sdk/main'

/**
 * 下载管线。
 *
 * 只做传输：任务登记、并发调度、分段 / 续传、缓存、SHA1 校验、暂停取消重试、
 * 进度与任务记录。内容分析（原版 / 加载器 / 社区 / 整合包 / 各类资源包）都在
 * 各自插件里完成，通过 `download/*` 事件把「文件清单 + 候选源」交进来。
 */

let taskSeq = 0
let jobSeq = 0

interface PipelineTask {
  id: string
  jobId: string
  url: string
  savePath: string
  sha1: string
  size: number
  label: string
  sources: DownloadEndpoint[]
  guardDir?: string
  /** 多源竞速：同时向所有源发起请求，谁先完成用谁 */
  race?: boolean
  state: DownloadTaskState
  progress: { loaded: number; total: number; speed: number; label: string }
  transferred?: number
  error?: string
  createdAt: number
}

interface PipelineJob {
  id: string
  kind: string
  title: string
  detail?: string
  scope?: { instanceName?: string }
  data?: unknown
  display?: DownloadJobRequest['display']
  /** 全部文件完成即结算，不需要编排方收尾 */
  autoFinish?: boolean
  state: DownloadJobState
  paused?: boolean
  /** 编排方已经提交完全部文件；封口前不结算整个任务 */
  sealed?: boolean
  /** 自动重试轮次：所有源都失败的文件推迟到本轮末尾再试 */
  retryRound?: number
  /** 上一轮失败文件数；新一轮没有减少就停止重试 */
  failedBeforeRound?: number
  note?: string
  preparePercent?: number
  prepareLoaded?: number
  prepareTotal?: number
  prepareTransferAt?: number
  taskIds: string[]
  createdAt: number
  error?: string
  stats?: InstallJobStats
}

interface StoredRecords {
  jobs: PipelineJob[]
  tasks: PipelineTask[]
}

/** 同一文件在同一个源上的尝试次数；用尽后换下一个源 */
const SOURCE_ATTEMPTS = 3
/** 所有源都失败后，整个任务最多自动重试几轮 */
const RETRY_ROUNDS = 3
/** 同一个源连续失败时的退避基数 */
const RETRY_DELAY_MS = 350
const CACHE_PRUNE_DELAY_MS = 5000
const CACHE_TRANSIENT_RE = /\.part(?:\d+)?(?:\.segments\.json)?(?:\.tmp)?$/

function maxSequence(ids: Iterable<string>, prefix: string): number {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const value = Number(id.slice(prefix.length))
    if (Number.isInteger(value)) max = Math.max(max, value)
  }
  return max
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isValidTerminal(state: DownloadTaskState): boolean {
  return state === 'done' || state === 'failed'
}

export const name = 'mics.download.manager'
export const inject = ['ipc', 'storage', 'capabilities', 'host']

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.manager')
  const appVersion = ctx.host.app.version

  const jobs = new Map<string, PipelineJob>()
  const tasks = new Map<string, PipelineTask>()
  /** 正在传输的句柄：暂停/取消时用它中断请求（.part 保留） */
  const transfers = new Map<string, FileTransferHandle>()
  /** 每个任务当前下载轮次；暂停后立刻恢复时靠它丢弃上一轮的迟到回调 */
  const downloadRuns = new Map<string, number>()
  const cancelledTasks = new Set<string>()
  const pausedJobs = new Set<string>()
  /** 等待某个任务进入终态的调用方 */
  const taskWaiters = new Map<string, Array<(result: DownloadFileResult) => void>>()

  const dataDir = ctx.host.paths.userData
  const cacheRoot = path.join(dataDir, 'cache', 'downloads')
  const cachePins = new Map<string, number>()
  let cachePruneTimer: ReturnType<typeof setTimeout> | null = null
  let cachePruneChain: Promise<void> = Promise.resolve()
  let cachePruneRequested = false

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 })

  /**
   * 下载管线统一的请求头。
   *
   * BMCLAPI 会把 maven / assets 请求 302 到 CERNET、NJU 等镜像节点，这些节点
   * 会直接拒绝没有 User-Agent 的请求（403）。
   */
  function downloadHeaders(): Record<string, string> {
    return { 'User-Agent': micsUserAgent(appVersion), Accept: '*/*' }
  }

  // 默认传输实现由本插件提供：沙箱 / 镜像插件可以用更高 priority 注册同名能力
  // 整体替换，下载管线不需要改。
  ctx.capabilities.provide<FileTransferCapability>(FILE_TRANSFER, {
    label: 'local',
    create: (spec) => createFileTransfer(spec as FileTransferOptions)
  })
  log.info('file-transfer 能力已注册（provider=local）')

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let recordsDirty = false

  function flushRecords(): void {
    recordsDirty = false
    try {
      ctx.storage.set('records', {
        jobs: [...jobs.values()],
        tasks: [...tasks.values()]
      } satisfies StoredRecords)
    } catch {
      /* 退出或存储不可用时忽略，避免阻塞关闭 */
    }
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
      const job = value as PipelineJob & {
        instanceName?: string
        gameVersion?: string
        loader?: unknown
        mode?: unknown
        packKind?: unknown
      }
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.taskIds)) continue
      job.taskIds = job.taskIds.filter((id): id is string => typeof id === 'string')
      job.kind = typeof job.kind === 'string' ? job.kind : 'game'
      // 只有真实实例的安装才进 install/status；Mod / 资源包任务不参与实例状态
      if (!job.scope && job.instanceName && (job.kind === 'game' || job.kind === 'modpack')) {
        job.scope = { instanceName: job.instanceName }
      }
      job.title =
        typeof job.title === 'string' && job.title ? job.title : (job.instanceName ?? job.id)
      job.display = job.display ?? {
        ...(typeof job.packKind === 'string' ? { packKind: job.packKind } : {}),
        ...(typeof job.gameVersion === 'string' ? { gameVersion: job.gameVersion } : {}),
        ...(typeof job.loader === 'object' && job.loader ? { loader: job.loader as never } : {}),
        ...(typeof job.mode === 'string' ? { mode: job.mode } : {})
      }
      // 旧版本没有这几个状态：准备阶段中断的安装无法续上，明确标为失败
      const legacyState: string = job.state
      if (legacyState === 'preparing') {
        job.state = 'failed'
        job.error = '应用退出时仍在准备下载清单'
        job.note = undefined
        job.preparePercent = undefined
      } else if (legacyState === 'ready') {
        // 旧版的 ready 表示「清单已就绪、开始下载」
        job.state = 'downloading'
      } else if (!legacyState) {
        job.state = 'done'
      }
      if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
        job.sealed = true
      }
      // 单批任务（autoFinish）在退出时可能还没收到 seal：文件清单已经完整
      if (job.autoFinish) job.sealed = true
      // 旧版记录没有编排方私有状态：新插件无法接手收尾，标为失败让用户重装
      if (job.data === undefined && (legacyState === 'ready' || job.state === 'finalizing')) {
        job.state = 'failed'
        job.error = '升级前的安装记录无法继续，请删除后重新安装'
      }
      jobs.set(job.id, job)
    }

    for (const value of raw.tasks) {
      const task = value as PipelineTask & { installId?: string; direct?: boolean }
      if (!task || typeof task.id !== 'string') continue
      const jobId = typeof task.jobId === 'string' ? task.jobId : task.installId
      if (!jobId || !jobs.has(jobId) || !task.progress || typeof task.progress !== 'object')
        continue
      task.jobId = jobId
      task.sources =
        Array.isArray(task.sources) && task.sources.length > 0
          ? task.sources
          : [{ id: `direct:${task.url}`, label: '直链', url: task.url }]
      if (task.state !== 'done' && task.state !== 'failed') {
        // 上次退出时还在队列/下载/校验中的任务，重启后以暂停状态等待恢复
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

    // 终态安装不再需要逐文件明细：历史行只显示汇总
    for (const job of jobs.values()) {
      if (job.state === 'done' || job.state === 'cancelled') archiveJob(job)
    }

    if (jobs.size > 0 || raw.jobs.length > 0) persistRecords(true)
  }

  function archiveJob(job: PipelineJob): void {
    if (job.taskIds.length === 0) {
      if (!job.stats) job.stats = collectStats(job)
      return
    }
    job.stats = collectStats(job)
    for (const taskId of job.taskIds) tasks.delete(taskId)
    job.taskIds = []
  }

  // -------------------------------------------------------------------------
  // 缓存
  // -------------------------------------------------------------------------

  function cachePath(sha1: string): string {
    return path.join(cacheRoot, sha1.slice(0, 2), sha1.slice(2))
  }

  /** 无摘要文件的缓存键：按 URL 归档（安装器 jar 等） */
  function urlCachePath(url: string): string {
    const key = createHash('sha1').update(url).digest('hex')
    return path.join(cacheRoot, 'url', key.slice(0, 2), key)
  }

  function loadCacheLimit(): string {
    return normalizeDownloadCacheLimit(
      ctx.storage.get<string>('cacheLimit', DEFAULT_DOWNLOAD_CACHE_LIMIT)
    )
  }

  function cacheEnabled(): boolean {
    return loadCacheLimit() !== DOWNLOAD_CACHE_LIMIT_OFF
  }

  function describeCacheLimit(raw: string): string {
    const { mode, megabytes } = parseDownloadCacheLimit(raw)
    if (mode === 'off') return '不缓存'
    if (mode === 'unlimited') return '无限制'
    return `${megabytes} MB`
  }

  function migrateCacheLimitSetting(): void {
    if (ctx.storage.get<string>('cacheLimitUnit') === 'mb') return
    const raw = ctx.storage.get<unknown>('cacheLimit')
    let migrated = DEFAULT_DOWNLOAD_CACHE_LIMIT
    if (typeof raw === 'string' || typeof raw === 'number') {
      const legacy = String(raw).trim()
      if (legacy === '0') migrated = DOWNLOAD_CACHE_LIMIT_UNLIMITED
      else if (legacy === '2' || legacy === '5' || legacy === '10') {
        migrated = String(Number(legacy) * 1024)
      } else if (legacy) {
        migrated = normalizeDownloadCacheLimit(legacy)
      }
    }
    ctx.storage.set('cacheLimit', migrated)
    ctx.storage.set('cacheLimitUnit', 'mb')
    log.info('下载缓存上限已迁移为 MB 单位：%s', describeCacheLimit(migrated))
  }

  function pinCacheFile(file: string): () => void {
    const key = path.resolve(file)
    cachePins.set(key, (cachePins.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (cachePins.get(key) ?? 1) - 1
      if (count > 0) cachePins.set(key, count)
      else cachePins.delete(key)
    }
  }

  function cacheFilePinned(file: string): boolean {
    return cachePins.has(path.resolve(file))
  }

  async function touchCacheFile(file: string): Promise<void> {
    try {
      const now = new Date()
      await utimes(file, now, now)
    } catch {
      /* 与清理流程竞争时忽略 */
    }
  }

  async function cacheUsage(): Promise<{ bytes: number; files: number }> {
    let bytes = 0
    let files = 0
    const stack = [cacheRoot]
    while (stack.length > 0) {
      const dir = stack.pop()
      if (!dir) continue
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && !CACHE_TRANSIENT_RE.test(entry.name)) {
          try {
            bytes += (await stat(full)).size
            files += 1
          } catch {
            /* 统计期间被删除 */
          }
        }
      }
    }
    return { bytes, files }
  }

  async function pruneCacheOnce(): Promise<void> {
    const limit = downloadCacheLimitBytes(loadCacheLimit())
    if (limit === null) return

    const entries: Array<{ file: string; size: number; mtimeMs: number }> = []
    let total = 0
    const stack = [cacheRoot]
    while (stack.length > 0) {
      const dir = stack.pop()
      if (!dir) continue
      let items
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of items) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!entry.isFile() || CACHE_TRANSIENT_RE.test(entry.name)) continue
        if (cacheFilePinned(full)) continue
        try {
          const info = await stat(full)
          entries.push({ file: full, size: info.size, mtimeMs: info.mtimeMs })
          total += info.size
        } catch {
          /* 扫描期间被删除 */
        }
      }
    }

    if (total <= limit) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)

    let removed = 0
    let freed = 0
    for (const entry of entries) {
      if (total <= limit) break
      // 清理期间设置可能被改回「无限制」或换了数值，交给下一轮按新策略处理
      if (downloadCacheLimitBytes(loadCacheLimit()) !== limit) return
      if (cacheFilePinned(entry.file)) continue
      try {
        await rm(entry.file, { force: true })
        total -= entry.size
        freed += entry.size
        removed += 1
      } catch {
        /* 已被其它流程删除或仍被占用 */
      }
    }
    if (removed > 0) {
      log.info('下载缓存已清理 %d 个文件（%d 字节），当前上限 %d 字节', removed, freed, limit)
    }
  }

  function scheduleCachePrune(delay = CACHE_PRUNE_DELAY_MS): void {
    if (cachePruneTimer) return
    cachePruneTimer = setTimeout(() => {
      cachePruneTimer = null
      void enqueueCachePrune()
    }, delay)
  }

  function enqueueCachePrune(): Promise<void> {
    cachePruneRequested = true
    cachePruneChain = cachePruneChain
      .then(async () => {
        if (!cachePruneRequested) return
        cachePruneRequested = false
        await pruneCacheOnce()
      })
      .catch((cause) => {
        log.warn('下载缓存清理失败：%s', toError(cause).message)
      })
    return cachePruneChain
  }

  async function pruneCacheNow(): Promise<void> {
    if (cachePruneTimer) {
      clearTimeout(cachePruneTimer)
      cachePruneTimer = null
    }
    await enqueueCachePrune()
  }

  function hashFile(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash('sha1')
      const stream = createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk as Buffer))
      stream.on('error', () => resolve(null))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  /** 目标文件是否已完整；补全时据此跳过已下载的文件 */
  async function fileMatchesSpec(task: PipelineTask): Promise<boolean> {
    try {
      const info = await stat(task.savePath)
      if (!info.isFile()) return false
      if (task.sha1) {
        if (task.size > 0 && info.size !== task.size) return false
        return (await hashFile(task.savePath)) === task.sha1
      }
      if (task.size > 0) return info.size === task.size
      if (task.savePath.toLowerCase().endsWith('.jar')) return isReadableJar(task.savePath)
      return info.size > 0
    } catch {
      return false
    }
  }

  async function tryCopyFromCache(task: PipelineTask): Promise<boolean> {
    if (!cacheEnabled()) return false
    const cached = task.sha1 ? cachePath(task.sha1) : urlCachePath(task.url)
    const release = pinCacheFile(cached)
    try {
      if (!existsSync(cached)) return false
      if (task.sha1) {
        if ((await hashFile(cached)) !== task.sha1) {
          await rm(cached, { force: true }).catch(() => undefined)
          log.warn('下载缓存内容与摘要不符，已丢弃：%s', task.sha1)
          return false
        }
      } else {
        const info = await stat(cached).catch(() => null)
        if (!info?.isFile() || info.size === 0) return false
        if (task.size > 0 && info.size !== task.size) return false
        if (task.savePath.toLowerCase().endsWith('.jar') && !isReadableJar(cached)) return false
      }
      ensureDir(path.dirname(task.savePath))
      await copyFile(cached, task.savePath)
      await touchCacheFile(cached)
      return true
    } finally {
      release()
    }
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  const maxConcurrency = () => {
    const fallback = Number(DEFAULT_DOWNLOAD_CONCURRENCY) || 64
    const raw = ctx.storage.get<string>('concurrency', DEFAULT_DOWNLOAD_CONCURRENCY)
    return Math.max(1, Math.min(128, Number(raw) || fallback))
  }

  function segmentsFor(task: PipelineTask): number {
    if (task.size < segmentThresholdBytes()) return 1
    return parseDownloadSegments(ctx.storage.get<string>('segments', DEFAULT_DOWNLOAD_SEGMENTS))
  }

  function segmentThresholdBytes(): number {
    const megabytes = parseDownloadSegmentThresholdMb(
      ctx.storage.get<string>('segmentThreshold', DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD)
    )
    return megabytes * 1024 * 1024
  }

  // -------------------------------------------------------------------------
  // 任务状态与进度
  // -------------------------------------------------------------------------

  function collectStats(job: PipelineJob): InstallJobStats {
    let total = 0
    let waiting = 0
    let paused = 0
    let downloading = 0
    let done = 0
    let failed = 0
    let cancelled = 0
    let loaded = 0
    let bytes = 0
    let transferred = 0

    for (const taskId of job.taskIds) {
      const task = tasks.get(taskId)
      if (!task) continue
      total += 1
      switch (task.state) {
        case 'done':
          done += 1
          break
        case 'failed':
          failed += 1
          if (task.error === '已取消') cancelled += 1
          break
        case 'downloading':
        case 'verifying':
          downloading += 1
          break
        case 'paused':
          paused += 1
          break
        default:
          waiting += 1
      }
      loaded += task.progress.loaded
      transferred += task.transferred ?? 0
      bytes += task.progress.total > 0 ? task.progress.total : Math.max(task.size, 0)
    }

    const measured =
      bytes > 0 ? (loaded / bytes) * 100 : total > 0 ? ((done + failed) / total) * 100 : 0

    return {
      total,
      waiting,
      paused,
      downloading,
      done,
      failed,
      cancelled,
      loaded,
      bytes,
      transferred,
      percent: Math.min(100, Math.max(0, Math.round(measured)))
    }
  }

  function statsOf(job: PipelineJob): InstallJobStats {
    if (job.taskIds.length === 0 && job.stats) return job.stats
    return collectStats(job)
  }

  function toSummary(job: PipelineJob): InstallJobSummary {
    const stats = statsOf(job)
    const state = job.state === 'downloading' || job.state === 'finalizing' ? 'ready' : job.state
    return {
      id: job.id,
      kind: job.kind as InstallJobKind,
      packKind: job.display?.packKind as never,
      title: job.title,
      detail: job.detail,
      instanceName: job.scope?.instanceName ?? job.title,
      gameVersion: job.display?.gameVersion ?? '',
      loader: job.display?.loader as never,
      mode: job.display?.mode as never,
      state,
      error: job.error,
      note: job.note,
      preparePercent: job.preparePercent,
      prepareLoaded: job.prepareLoaded,
      prepareTotal: job.prepareTotal,
      prepareTransferAt: job.prepareTransferAt,
      createdAt: job.createdAt,
      finished: job.state === 'done' || job.state === 'failed' || job.state === 'cancelled',
      stats
    }
  }

  function jobSequence(job: PipelineJob): number {
    const sequence = Number(job.id.startsWith('job_') ? job.id.slice('job_'.length) : '')
    return Number.isFinite(sequence) ? sequence : job.createdAt
  }

  function isFinished(job: PipelineJob): boolean {
    return job.state === 'done' || job.state === 'failed' || job.state === 'cancelled'
  }

  function resolveWaiters(task: PipelineTask): void {
    if (!isValidTerminal(task.state)) return
    const waiters = taskWaiters.get(task.id)
    if (!waiters || waiters.length === 0) return
    taskWaiters.delete(task.id)
    const result: DownloadFileResult = {
      taskId: task.id,
      state: task.state === 'done' ? 'done' : 'failed',
      ...(task.error ? { error: task.error } : {})
    }
    for (const resolve of waiters) resolve(result)
  }

  function waitForTask(taskId: string): Promise<DownloadFileResult> {
    const task = tasks.get(taskId)
    if (!task) return Promise.resolve({ taskId, state: 'failed', error: '任务不存在' })
    if (isValidTerminal(task.state)) {
      return Promise.resolve({
        taskId,
        state: task.state === 'done' ? 'done' : 'failed',
        ...(task.error ? { error: task.error } : {})
      })
    }
    return new Promise((resolve) => {
      const waiters = taskWaiters.get(taskId) ?? []
      waiters.push(resolve)
      taskWaiters.set(taskId, waiters)
    })
  }

  /** 任务进入终态：发通知、唤醒等待者、尝试结算所属任务 */
  function settleTask(task: PipelineTask): void {
    if (!isValidTerminal(task.state)) return
    ctx.emit('download/fileFinished', task.jobId, {
      taskId: task.id,
      state: task.state === 'done' ? 'done' : 'failed',
      ...(task.error ? { error: task.error } : {})
    })
    resolveWaiters(task)
    void settleJob(task.jobId)
  }

  /**
   * 汇总一次任务的终态：
   * - 有失败且没有未结束任务 -> failed；
   * - 全部完成 -> finalizing，等编排方 finish；
   * - 还有进行中的任务 -> 保持 downloading。
   */
  async function settleJob(jobId: string): Promise<void> {
    const job = jobs.get(jobId)
    if (!job || isFinished(job) || job.state === 'finalizing') return
    if (!job.sealed) return
    if (job.taskIds.length === 0) return

    const list = job.taskIds.map((id) => tasks.get(id))
    if (list.length !== job.taskIds.length) return
    // 还有在途 / 暂停的任务时先等；deferred 表示本轮所有源都失败，可以进入重试轮
    if (
      list.some(
        (task) =>
          !task ||
          task.state === 'pending' ||
          task.state === 'downloading' ||
          task.state === 'verifying' ||
          task.state === 'paused'
      )
    ) {
      return
    }

    const deferred = list.filter(
      (task): task is PipelineTask => task !== undefined && task.state === 'deferred'
    )
    if (deferred.length > 0) {
      const round = job.retryRound ?? 0
      const previous = job.failedBeforeRound
      // 重试后失败数没有减少（或达到轮次上限）就结束，避免无限重试
      if (round >= RETRY_ROUNDS || (previous !== undefined && deferred.length >= previous)) {
        for (const task of deferred) {
          task.state = 'failed'
          task.error = task.error ?? '所有下载源均失败'
        }
        job.state = 'failed'
        job.error = `${deferred.length} 个文件下载失败，可重试或删除该安装`
        job.note = undefined
        job.stats = collectStats(job)
        log.warn('下载任务「%s」未完成：%s，job %s', job.title, job.error, job.id)
        persistRecords(true)
        emitFinished(job)
        return
      }

      job.retryRound = round + 1
      job.failedBeforeRound = deferred.length
      job.state = 'downloading'
      job.note = `第 ${job.retryRound} 轮重试：${deferred.length} 个文件`
      for (const task of deferred) {
        task.state = 'pending'
        delete task.error
        task.progress.loaded = partSizeOf(task.savePath)
        task.progress.total = task.size > 0 ? task.size : task.progress.total
        task.progress.speed = 0
        cancelledTasks.delete(task.id)
      }
      log.info(
        '下载任务「%s」进入第 %d 轮重试：%d 个文件',
        job.title,
        job.retryRound,
        deferred.length
      )
      persistRecords(true)
      scheduleLoop()
      return
    }

    const failedTasks = list.filter(
      (task): task is PipelineTask => task !== undefined && task.state === 'failed'
    )
    if (failedTasks.length > 0) {
      job.state = 'failed'
      job.error = `${failedTasks.length} 个文件下载失败，可重试或删除该安装`
      // 失败任务要留给「重试」：这里只记录汇总，不删除逐文件明细
      job.stats = collectStats(job)
      log.warn('下载任务「%s」未完成：%s，job %s', job.title, job.error, job.id)
      persistRecords(true)
      emitFinished(job)
      return
    }

    if (job.autoFinish) {
      job.state = 'done'
      delete job.error
      job.note = undefined
      job.preparePercent = undefined
      job.stats = collectStats(job)
      archiveJob(job)
      persistRecords(true)
      emitFinished(job)
      return
    }

    job.state = 'finalizing'
    job.note = '正在完成安装…'
    job.preparePercent = undefined
    persistRecords(true)
    ctx.emit('download/filesDone', job.id)
  }

  function emitFinished(job: PipelineJob): void {
    const result: DownloadJobResult = {
      jobId: job.id,
      state: job.state === 'done' || job.state === 'cancelled' ? job.state : 'failed',
      stats: { ...statsOf(job), transferred: statsOf(job).transferred ?? 0 },
      ...(job.error ? { error: job.error } : {})
    }
    ctx.emit('download/jobFinished', job.id, result)
  }

  // -------------------------------------------------------------------------
  // 调度与传输
  // -------------------------------------------------------------------------

  function scheduleLoop(): void {
    const active = [...tasks.values()].filter((task) => task.state === 'downloading').length
    const slots = maxConcurrency() - active
    if (slots <= 0) return
    const pending = [...tasks.values()].filter(
      (task) => task.state === 'pending' && !pausedJobs.has(task.jobId)
    )
    for (const task of pending.slice(0, slots)) {
      void startDownload(task)
    }
  }

  function partSizeOf(savePath: string): number {
    const partPath = `${savePath}.part`
    const segmented = transferStateProgress(partPath)
    if (segmented !== null) return segmented
    try {
      return statSync(partPath).size
    } catch {
      return 0
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function dropCancelled(task: PipelineTask, ...files: string[]): Promise<boolean> {
    if (!cancelledTasks.has(task.id)) return false
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    for (const file of files) {
      await rm(file, { force: true }).catch(() => undefined)
      if (file.endsWith('.part')) {
        await rm(transferStatePath(file), { force: true }).catch(() => undefined)
      }
    }
    return true
  }

  function failTask(task: PipelineTask, error: string): void {
    task.state = 'failed'
    task.error = error
    task.progress.speed = 0
    task.transferred = task.transferred ?? 0
    persistRecords()
    scheduleLoop()
    settleTask(task)
  }

  /** 所有源都失败：先挂起，等本轮其它文件结束后由任务级重试轮次再试 */
  function deferTask(task: PipelineTask, error: string): void {
    task.state = 'deferred'
    task.error = error
    task.progress.speed = 0
    task.transferred = task.transferred ?? 0
    persistRecords()
    scheduleLoop()
    void settleJob(task.jobId)
  }

  type DownloadOutcome =
    | { status: 'done'; partPath: string }
    | { status: 'paused' }
    | { status: 'aborted' }
    | { status: 'deferred'; error: string }
    | { status: 'failed'; error: string }

  function newTransfer(
    task: PipelineTask,
    candidate: DownloadEndpoint,
    partPath: string,
    onProgress: (progress: TransferProgress) => void
  ): FileTransferHandle {
    return ctx.capabilities.require<FileTransferCapability>(FILE_TRANSFER).create({
      url: candidate.url,
      partPath,
      sha1: task.sha1,
      // 没有摘要的文件不做断点续传：服务端忽略 Range 时会把完整文件追加到
      // 残缺的 .part 后面，得到结构损坏却「下载完成」的文件
      size: task.sha1 && task.size > 0 ? task.size : 0,
      // 大文件才给多连接；服务端不支持 Range 时传输层自动回退单连接
      segments: segmentsFor(task),
      headers: downloadHeaders(),
      agents: { http: httpAgent, https: httpsAgent },
      onProgress,
      onRestart: () => {
        if (task.state === 'downloading') task.progress.loaded = 0
      }
    })
  }

  async function removePart(partPath: string): Promise<void> {
    await rm(partPath, { force: true }).catch(() => undefined)
    await rm(transferStatePath(partPath), { force: true }).catch(() => undefined)
  }

  /** 校验下载结果；失败时删掉残缺文件并返回错误 */
  async function verifyPart(
    task: PipelineTask,
    partPath: string,
    digest: string | undefined
  ): Promise<string | null> {
    if (task.sha1 && digest !== task.sha1) {
      await removePart(partPath)
      return `SHA1 校验失败：期望 ${task.sha1}，实际 ${digest ?? '未知'}`
    }
    if (!task.sha1 && task.savePath.toLowerCase().endsWith('.jar') && !isReadableJar(partPath)) {
      await removePart(partPath)
      return '下载的文件不是有效的 jar'
    }
    return null
  }

  /**
   * 顺序尝试：同一个源最多试 3 次，仍失败才换下一个源（按配置顺序）。
   * 所有源都失败时把任务推迟到本轮末尾，由任务级重试轮次处理。
   */
  async function downloadSequential(
    task: PipelineTask,
    candidates: DownloadEndpoint[],
    current: () => boolean,
    pausedNow: () => boolean
  ): Promise<DownloadOutcome> {
    const partPath = task.savePath + '.part'
    let lastError = '下载失败'

    for (const candidate of candidates) {
      for (let attempt = 1; attempt <= SOURCE_ATTEMPTS; attempt += 1) {
        if (!current()) return { status: 'aborted' }
        if (await dropCancelled(task, partPath)) return { status: 'aborted' }
        if (pausedNow()) return { status: 'paused' }

        task.state = 'downloading'
        let reported = task.progress.loaded
        const transfer = newTransfer(task, candidate, partPath, ({ loaded, total }) => {
          if (!current() || loaded <= reported) return
          task.transferred = (task.transferred ?? 0) + (loaded - reported)
          reported = loaded
          task.progress.loaded = loaded
          if (total > 0) {
            task.progress.total = total
            if (task.size <= 0) task.size = total
          }
        })
        transfers.set(task.id, transfer)

        let result: TransferOutcome
        try {
          result = await transfer.start()
        } catch (cause) {
          result = { status: 'failed', error: toError(cause) }
        } finally {
          if (transfers.get(task.id) === transfer) transfers.delete(task.id)
        }

        if (!current()) return { status: 'aborted' }
        if (await dropCancelled(task, partPath, task.savePath)) return { status: 'aborted' }

        if (result.status === 'paused') return { status: 'paused' }
        if (result.status === 'failed') {
          if (pausedNow()) return { status: 'paused' }
          lastError = result.error?.message ?? '下载失败'
          if (attempt < SOURCE_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt)
          continue
        }

        task.state = 'verifying'
        const invalid = await verifyPart(task, partPath, result.digest)
        if (invalid) {
          lastError = invalid
          if (attempt < SOURCE_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt)
          continue
        }
        return { status: 'done', partPath }
      }
    }

    return { status: 'deferred', error: lastError }
  }

  /**
   * 竞速：同时向所有源发起请求，谁先完成用谁的。
   *
   * 安装器、客户端这类「文件大、源之间速度差异大」的下载用它；失败的源
   * 立即停止并清理自己的 `.part`，不阻塞其它源。
   */
  async function downloadRace(
    task: PipelineTask,
    candidates: DownloadEndpoint[],
    current: () => boolean,
    pausedNow: () => boolean
  ): Promise<DownloadOutcome> {
    const handles: FileTransferHandle[] = []
    const parts: string[] = []
    let reported = 0
    let winner: { partPath: string } | null = null

    const lane = async (
      candidate: DownloadEndpoint,
      index: number
    ): Promise<{ partPath: string }> => {
      const partPath = `${task.savePath}.part${index}`
      parts.push(partPath)
      let lastError = '下载失败'

      for (let attempt = 1; attempt <= SOURCE_ATTEMPTS; attempt += 1) {
        if (!current() || pausedNow()) throw new Error('已暂停')
        const transfer = newTransfer(task, candidate, partPath, ({ loaded, total }) => {
          if (!current() || loaded <= reported) return
          task.transferred = (task.transferred ?? 0) + (loaded - reported)
          reported = loaded
          task.progress.loaded = loaded
          if (total > 0) {
            task.progress.total = total
            if (task.size <= 0) task.size = total
          }
        })
        handles.push(transfer)

        let result: TransferOutcome
        try {
          result = await transfer.start()
        } catch (cause) {
          result = { status: 'failed', error: toError(cause) }
        }

        if (!current() || pausedNow()) throw new Error('已暂停')
        if (result.status === 'done') {
          const invalid = await verifyPart(task, partPath, result.digest)
          if (!invalid) return { partPath }
          lastError = invalid
        } else {
          lastError = result.error?.message ?? '下载失败'
        }
        if (attempt < SOURCE_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt)
      }

      throw new Error(lastError)
    }

    // 把并发请求登记成一个合成句柄，暂停 / 取消时一次性停掉所有源
    transfers.set(task.id, {
      start: async () => ({ status: 'paused' }),
      stop: async () => {
        await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)))
      }
    })

    try {
      winner = await Promise.any(candidates.map((candidate, index) => lane(candidate, index)))
      return { status: 'done', partPath: winner.partPath }
    } catch (cause) {
      if (!current()) return { status: 'aborted' }
      if (pausedNow()) return { status: 'paused' }
      const message =
        cause instanceof AggregateError
          ? cause.errors[0] instanceof Error
            ? cause.errors[0].message
            : String(cause.errors[0])
          : cause instanceof Error
            ? cause.message
            : String(cause)
      return { status: 'deferred', error: message || '下载失败' }
    } finally {
      await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)))
      transfers.delete(task.id)
      for (const partPath of parts) {
        if (partPath !== winner?.partPath) await removePart(partPath)
      }
    }
  }

  async function startDownload(task: PipelineTask): Promise<void> {
    if (cancelledTasks.has(task.id) || pausedJobs.has(task.jobId) || task.state !== 'pending')
      return

    // 暂停后马上恢复时，上一轮下载可能还没退出；用代号确保只有最新一轮能改状态
    const run = (downloadRuns.get(task.id) ?? 0) + 1
    downloadRuns.set(task.id, run)
    const current = (): boolean => downloadRuns.get(task.id) === run

    task.state = 'downloading'
    task.progress.speed = 0
    const pausedNow = (): boolean => pausedJobs.has(task.jobId) || task.state === 'paused'

    // 目标目录可能在排队期间被删除；不要靠 ensureDir 把已删除的实例复活
    if (task.guardDir && !existsSync(task.guardDir)) {
      failTask(task, '目标实例或存档已被删除')
      return
    }

    // 另一个实例已经装过的文件直接复用，不必再走下载或缓存复制
    if (await fileMatchesSpec(task)) {
      if (!current()) return
      task.progress.loaded = task.size
      if (task.size > 0) task.progress.total = task.size
      task.state = 'done'
      persistRecords()
      scheduleLoop()
      settleTask(task)
      return
    }

    if (task.sha1) {
      try {
        if (await tryCopyFromCache(task)) {
          if (!current()) return
          if (await dropCancelled(task, task.savePath)) return
          if (pausedNow()) {
            task.state = 'paused'
            task.progress.speed = 0
            persistRecords()
            return
          }
          if (task.size > 0) {
            task.progress.loaded = task.size
            task.progress.total = task.size
          }
          task.state = 'done'
          persistRecords()
          scheduleLoop()
          settleTask(task)
          return
        }
      } catch {
        /* 缓存不可用时退回网络下载 */
      }
    }
    if (!current()) return

    const candidates =
      task.sources.length > 0
        ? task.sources
        : [{ id: `direct:${task.url}`, label: '直链', url: task.url }]

    try {
      ensureDir(path.dirname(task.savePath))
    } catch (cause) {
      failTask(task, `无法创建下载目录：${toError(cause).message}`)
      return
    }

    const outcome = task.race
      ? await downloadRace(task, candidates, current, pausedNow)
      : await downloadSequential(task, candidates, current, pausedNow)

    if (outcome.status === 'aborted') return
    if (outcome.status === 'paused') {
      task.state = 'paused'
      task.progress.speed = 0
      persistRecords()
      return
    }
    if (outcome.status === 'failed') {
      failTask(task, outcome.error)
      return
    }
    if (outcome.status === 'deferred') {
      deferTask(task, outcome.error)
      return
    }

    if (await dropCancelled(task, outcome.partPath)) return
    try {
      await rename(outcome.partPath, task.savePath)
    } catch (cause) {
      failTask(task, `无法写入目标文件：${toError(cause).message}`)
      return
    }

    if (await dropCancelled(task, task.savePath)) return

    const cacheLimit = downloadCacheLimitBytes(loadCacheLimit())
    const cacheTarget =
      cacheEnabled() && (cacheLimit === null || task.size <= cacheLimit)
        ? task.sha1
          ? cachePath(task.sha1)
          : urlCachePath(task.url)
        : ''
    if (cacheTarget && !existsSync(cacheTarget)) {
      const release = pinCacheFile(cacheTarget)
      try {
        ensureDir(path.dirname(cacheTarget))
        await copyFile(task.savePath, cacheTarget)
        await touchCacheFile(cacheTarget)
        scheduleCachePrune()
      } catch {
        /* 缓存只是加速手段，写不进去不影响本次安装 */
      } finally {
        release()
      }
    }

    if (!current()) return
    if (await dropCancelled(task, task.savePath)) return

    if (task.size > 0) {
      task.progress.loaded = task.size
      task.progress.total = task.size
    }
    task.progress.speed = 0
    task.state = 'done'
    persistRecords()
    scheduleLoop()
    settleTask(task)
  }

  function nextTaskId(): string {
    taskSeq += 1
    return `task_${taskSeq}`
  }

  function nextJobId(): string {
    jobSeq += 1
    return `job_${jobSeq}`
  }

  function enqueueTasks(job: PipelineJob, files: DownloadFileRequest[], paused: boolean): string[] {
    // 大文件优先：并发充足时先啃硬骨头，尾部的剩余任务更小
    const ordered = [...files].sort((a, b) => Math.max(b.size ?? 0, 0) - Math.max(a.size ?? 0, 0))
    const taskIds: string[] = []
    for (const file of ordered) {
      const task: PipelineTask = {
        id: nextTaskId(),
        jobId: job.id,
        url: file.url,
        savePath: file.savePath,
        sha1: file.sha1 ?? '',
        size: file.size ?? 0,
        label: file.label,
        sources:
          Array.isArray(file.sources) && file.sources.length > 0
            ? file.sources
            : [{ id: `direct:${file.url}`, label: '直链', url: file.url }],
        ...(file.race ? { race: true } : {}),
        ...(file.guardDir ? { guardDir: file.guardDir } : {}),
        state: paused ? 'paused' : 'pending',
        progress: {
          loaded: 0,
          total: (file.size ?? 0) > 0 ? (file.size ?? 0) : -1,
          speed: 0,
          label: file.label
        },
        createdAt: Date.now()
      }
      tasks.set(task.id, task)
      job.taskIds.push(task.id)
      taskIds.push(task.id)
    }
    return taskIds
  }

  // -------------------------------------------------------------------------
  // 事件：管线请求
  // -------------------------------------------------------------------------

  ctx.on('download/create', async (request: DownloadJobRequest): Promise<DownloadJobHandle> => {
    if (!request || typeof request.title !== 'string') throw new Error('缺少任务标题')
    const job: PipelineJob = {
      id: nextJobId(),
      kind: typeof request.kind === 'string' && request.kind ? request.kind : 'download',
      title: request.title.slice(0, 120),
      ...(request.detail ? { detail: request.detail.slice(0, 120) } : {}),
      ...(request.scope ? { scope: request.scope } : {}),
      ...(request.data !== undefined ? { data: request.data } : {}),
      ...(request.display ? { display: request.display } : {}),
      ...(request.autoFinish ? { autoFinish: true } : {}),
      state: 'preparing',
      taskIds: [],
      createdAt: Date.now()
    }
    jobs.set(job.id, job)
    persistRecords()
    ctx.emit('download/started', job.id)
    log.info('已受理下载任务「%s」（%s），job %s', job.title, job.kind, job.id)
    return { jobId: job.id }
  })

  ctx.on(
    'download/addFiles',
    async (request: DownloadAddFilesRequest): Promise<DownloadAddFilesResult> => {
      const job = jobs.get(request.jobId)
      if (!job) throw new Error('下载任务不存在')
      if (isFinished(job)) throw new Error('下载任务已结束')
      const files = Array.isArray(request.files) ? request.files : []
      for (const file of files) {
        if (!file || typeof file.url !== 'string' || typeof file.savePath !== 'string') {
          throw new Error('下载文件缺少地址或目标路径')
        }
        if (!path.isAbsolute(file.savePath))
          throw new Error(`下载目标必须是绝对路径：${file.savePath}`)
      }
      if (files.length === 0) return { taskIds: [] }

      const taskIds = enqueueTasks(job, files, pausedJobs.has(job.id))
      job.sealed = false
      if (job.state === 'preparing') job.state = 'downloading'
      persistRecords()
      if (!job.paused && !pausedJobs.has(job.id)) scheduleLoop()
      log.info('任务「%s」追加 %d 个文件，job %s', job.title, files.length, job.id)
      return { taskIds }
    }
  )

  ctx.on('download/awaitFiles', async (request: DownloadAwaitRequest) => {
    const ids = Array.isArray(request.taskIds) ? request.taskIds : []
    return Promise.all(ids.map((taskId) => waitForTask(taskId)))
  })

  ctx.on('download/finish', async (request: DownloadFinishRequest) => {
    const job = jobs.get(request.jobId)
    if (!job) return
    if (job.state === 'cancelled') return

    if (request.state === 'failed') {
      // 编排方放弃时，停止仍在进行的传输，避免它继续往半成品目录写文件
      for (const taskId of job.taskIds) {
        const task = tasks.get(taskId)
        if (task && !isValidTerminal(task.state)) await cancelTask(task)
      }
      job.state = 'failed'
      job.error = request.error ?? job.error ?? '下载任务失败'
      job.note = undefined
      job.stats = collectStats(job)
      persistRecords(true)
      emitFinished(job)
      log.warn('下载任务「%s」失败：%s，job %s', job.title, job.error, job.id)
      return
    }

    const failed = job.taskIds
      .map((id) => tasks.get(id))
      .filter((task) => task?.state === 'failed' && task.error !== '已取消')
    if (failed.length > 0) {
      job.state = 'failed'
      job.error = `${failed.length} 个文件下载失败，可重试或删除该安装`
      job.stats = collectStats(job)
      persistRecords(true)
      emitFinished(job)
      return
    }

    job.state = 'done'
    delete job.error
    job.note = undefined
    job.preparePercent = undefined
    job.prepareLoaded = undefined
    job.prepareTotal = undefined
    archiveJob(job)
    persistRecords(true)
    emitFinished(job)
    log.info('下载任务「%s」已完成，job %s', job.title, job.id)
  })

  ctx.on('download/data', async (request) => {
    const job = jobs.get(request.jobId)
    if (!job || isFinished(job)) return
    job.data = request.data
    persistRecords()
  })

  ctx.on('download/seal', async (jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || isFinished(job)) return
    job.sealed = true
    if (job.state === 'preparing') job.state = 'downloading'
    persistRecords()
    await settleJob(jobId)
  })

  ctx.on('download/retry', async (jobId: string): Promise<boolean> => {
    const job = jobs.get(jobId)
    if (!job || job.state === 'done' || job.state === 'cancelled') return false
    const failed = job.taskIds
      .map((id) => tasks.get(id))
      .filter(
        (task): task is PipelineTask =>
          task !== undefined && task.state === 'failed' && task.error !== '已取消'
      )
    if (failed.length === 0) return false

    job.state = 'downloading'
    delete job.error
    job.paused = false
    job.retryRound = 0
    job.failedBeforeRound = undefined
    job.note = undefined
    pausedJobs.delete(job.id)
    for (const task of failed) {
      task.state = 'pending'
      delete task.error
      task.progress.loaded = partSizeOf(task.savePath)
      task.progress.total = task.size > 0 ? task.size : task.progress.total
      task.progress.speed = 0
      cancelledTasks.delete(task.id)
    }
    persistRecords(true)
    scheduleLoop()
    log.info('任务「%s」重试 %d 个失败文件，job %s', job.title, failed.length, job.id)
    return true
  })

  ctx.on('download/report', (jobId: string, patch: DownloadReportPatch) => {
    const job = jobs.get(jobId)
    if (!job || isFinished(job)) return
    const stepChanged = patch.note !== undefined && job.note !== patch.note
    if (patch.note !== undefined) job.note = patch.note
    if (patch.percent !== undefined && Number.isFinite(patch.percent)) {
      job.preparePercent = Math.max(0, Math.min(100, Math.round(patch.percent)))
    } else if (stepChanged) {
      job.preparePercent = undefined
    }
    if (patch.loaded !== undefined && patch.total !== undefined) {
      job.prepareLoaded = patch.loaded
      if (patch.total > 0) job.prepareTotal = patch.total
      job.prepareTransferAt = Date.now()
    }
    if (patch.bytes !== undefined && patch.bytes > 0) {
      job.prepareLoaded = (job.prepareLoaded ?? 0) + patch.bytes
      job.prepareTransferAt = Date.now()
    }
    persistRecords()
  })

  /** 旧版源配置：只读，供各插件启动时导入一次 */
  ctx.on('download/legacy-config', async (): Promise<LegacyDownloadConfig> => {
    const read = <T>(key: string, normalize: (value: unknown) => T): T | undefined => {
      const raw = ctx.storage.get<string>(key, '')
      if (!raw) return undefined
      try {
        return normalize(JSON.parse(raw))
      } catch {
        return undefined
      }
    }
    return {
      ...(read('sources', normalizeDownloadSources)
        ? { sources: read('sources', normalizeDownloadSources) }
        : {}),
      ...(read('loaderSources', normalizeLoaderSources)
        ? { loaderSources: read('loaderSources', normalizeLoaderSources) }
        : {}),
      ...(read('modSources', normalizeModSources)
        ? { modSources: read('modSources', normalizeModSources) }
        : {})
    }
  })

  // -------------------------------------------------------------------------
  // 启动恢复
  // -------------------------------------------------------------------------

  migrateCacheLimitSetting()
  loadRecords()
  if (jobs.size > 0 || tasks.size > 0) {
    log.info('下载记录已恢复：%d 个任务，%d 个文件', jobs.size, tasks.size)
  }
  scheduleCachePrune()

  // 延后派发：编排方（原版 / 整合包）在依赖本插件之后才注册 jobResumed 监听，
  // 立即 emit 会丢事件。3 秒足够所有启动插件挂完监听，也不影响首屏。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      for (const job of jobs.values()) {
        if (isFinished(job)) continue
        ctx.emit('download/jobResumed', job.id, {
          id: job.id,
          kind: job.kind,
          title: job.title,
          ...(job.detail ? { detail: job.detail } : {}),
          ...(job.scope ? { scope: job.scope } : {}),
          ...(job.data !== undefined ? { data: job.data } : {}),
          ...(job.display ? { display: job.display } : {}),
          state: job.state,
          ...(job.note ? { note: job.note } : {}),
          ...(job.error ? { error: job.error } : {}),
          taskIds: [...job.taskIds],
          createdAt: job.createdAt
        })
      }
    }, 3000)
    return () => clearTimeout(timer)
  })

  const flushOnQuit = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (recordsDirty) flushRecords()
  }
  ctx.effect(() => () => {
    flushOnQuit()
    httpAgent.destroy()
    httpsAgent.destroy()
  })

  // -------------------------------------------------------------------------
  // IPC：任务控制
  // -------------------------------------------------------------------------

  function pauseTask(task: PipelineTask): Promise<void> {
    if (task.state !== 'pending' && task.state !== 'downloading') return Promise.resolve()
    task.state = 'paused'
    task.progress.speed = 0
    const transfer = transfers.get(task.id)
    return transfer ? transfer.stop().catch(() => undefined) : Promise.resolve()
  }

  function resumeTask(task: PipelineTask): void {
    if (task.state !== 'paused') return
    task.state = 'pending'
    task.progress.speed = 0
  }

  async function cancelTask(task: PipelineTask): Promise<void> {
    if (task.state === 'done' || task.state === 'failed') return
    cancelledTasks.add(task.id)
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    const transfer = transfers.get(task.id)
    if (transfer) await transfer.stop().catch(() => undefined)
    const partPath = task.savePath + '.part'
    await rm(partPath, { force: true }).catch(() => undefined)
    await rm(transferStatePath(partPath), { force: true }).catch(() => undefined)
  }

  ctx.ipc.handle('tasks/list', () => [...tasks.values()])

  ctx.ipc.handle<{ taskId: string }>('tasks/cancel', async ({ taskId }) => {
    const task = tasks.get(taskId)
    if (task) await cancelTask(task)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/pause', async ({ taskId }) => {
    const task = tasks.get(taskId)
    if (task) await pauseTask(task)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/resume', ({ taskId }) => {
    const task = tasks.get(taskId)
    if (task) resumeTask(task)
    persistRecords(true)
    scheduleLoop()
  })

  // -------------------------------------------------------------------------
  // IPC：任务级控制与查询
  // -------------------------------------------------------------------------

  ctx.ipc.handle('install/list', () => [...jobs.values()])
  ctx.ipc.handle('install/summary', (): InstallJobSummary[] => [...jobs.values()].map(toSummary))

  /**
   * 展开详情：返回该任务里尚未完成的文件。
   *
   * 一次安装可能有几千个资源对象，全量返回会拖垮每 1.5 秒的轮询；只给
   * 正在下载 / 等待 / 失败的行，并限制条数，页面内部滚动查看。
   */
  ctx.ipc.handle<{ jobId: string }>('install/tasks', ({ jobId }): DownloadTaskView[] => {
    const job = jobs.get(jobId)
    if (!job) return []
    const priority: Record<DownloadTaskState, number> = {
      downloading: 0,
      verifying: 1,
      pending: 2,
      deferred: 3,
      paused: 4,
      failed: 5,
      done: 6
    }
    return job.taskIds
      .map((id) => tasks.get(id))
      .filter((task): task is PipelineTask => task !== undefined && task.state !== 'done')
      .sort((a, b) => priority[a.state] - priority[b.state])
      .slice(0, 300)
      .map((task) => ({
        id: task.id,
        label: task.label,
        state: task.state,
        loaded: task.progress.loaded,
        total: task.progress.total,
        size: task.size,
        ...(task.error ? { error: task.error } : {})
      }))
  })

  function liveStateOf(job: PipelineJob): InstallLiveState {
    if (job.state === 'preparing') return pausedJobs.has(job.id) ? 'paused' : 'preparing'
    if (job.state === 'done') return 'done'
    if (job.state === 'cancelled') return 'cancelled'
    if (job.state === 'failed') return 'failed'
    if (job.state === 'finalizing') return 'downloading'

    let active = 0
    let pending = 0
    let paused = 0
    let failed = 0
    for (const taskId of job.taskIds) {
      const task = tasks.get(taskId)
      if (!task || task.state === 'done') continue
      if (task.state === 'paused') paused += 1
      else if (task.state === 'failed') failed += 1
      else if (task.state === 'pending') pending += 1
      else active += 1
    }

    if (active > 0 || pending > 0) return 'downloading'
    if (paused > 0) return 'paused'
    if (failed > 0) return 'failed'
    return 'downloading'
  }

  ctx.ipc.handle('install/status', (): InstanceInstallStatus[] => {
    const latest = new Map<string, PipelineJob>()
    for (const job of jobs.values()) {
      const instanceName = job.scope?.instanceName
      if (!instanceName) continue
      const current = latest.get(instanceName)
      if (!current || jobSequence(job) >= jobSequence(current)) latest.set(instanceName, job)
    }

    return [...latest.values()].map((job) => ({
      instanceName: job.scope?.instanceName ?? job.title,
      jobId: job.id,
      state: liveStateOf(job),
      retryable:
        job.state === 'failed' &&
        job.taskIds.some((taskId) => {
          const task = tasks.get(taskId)
          return task !== undefined && task.state === 'failed' && task.error !== '已取消'
        })
    }))
  })

  ctx.ipc.handle<{ jobId: string }>('install/cancel', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (isFinished(job)) return
    pausedJobs.delete(jobId)
    job.state = 'cancelled'
    job.note = undefined
    job.preparePercent = undefined
    log.info('取消下载任务「%s」，job %s', job.title, job.id)
    await Promise.all(
      job.taskIds.map(async (taskId) => {
        const task = tasks.get(taskId)
        if (task) await cancelTask(task)
      })
    )
    archiveJob(job)
    persistRecords(true)
    emitFinished(job)
  })

  ctx.ipc.handle<{ jobId: string }>('install/pause', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job || isFinished(job)) return
    // 准备阶段还没有稳定的文件阶段：此时暂停只记状态，避免把加载器安装器
    // 正在 awaitFiles 的任务挂起，导致「准备下载清单」永远不结束。
    if (job.state === 'preparing') {
      job.paused = true
      persistRecords()
      return
    }
    pausedJobs.add(jobId)
    job.paused = true
    log.info('暂停下载任务「%s」，job %s', job.title, job.id)
    await Promise.all(
      job.taskIds.map(async (taskId) => {
        const task = tasks.get(taskId)
        if (task) await pauseTask(task)
      })
    )
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/resume', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job || isFinished(job)) return
    pausedJobs.delete(jobId)
    job.paused = false
    log.info('继续下载任务「%s」，job %s', job.title, job.id)
    for (const taskId of job.taskIds) {
      const task = tasks.get(taskId)
      if (task) resumeTask(task)
    }
    persistRecords(true)
    scheduleLoop()
  })

  ctx.ipc.handle<{ jobId: string }>('install/retry', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job || job.state === 'done' || job.state === 'cancelled') return
    const handled = await serialEvent(ctx, 'download/retry', jobId)
    if (!handled) throw new Error('该安装没有可续传的下载记录，请删除后重新安装')
  })

  ctx.ipc.handle<{ jobId: string }>('install/discard', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    const active =
      job.state === 'preparing' ||
      job.taskIds.some((taskId) => {
        const task = tasks.get(taskId)
        return task !== undefined && !isValidTerminal(task.state)
      })
    if (active) throw new Error('安装仍在进行，请先取消')

    for (const taskId of job.taskIds) tasks.delete(taskId)
    jobs.delete(jobId)
    pausedJobs.delete(jobId)
    persistRecords(true)
    ctx.emit('download/discarded', jobId)
    log.info('已删除下载记录「%s」，job %s', job.title, jobId)
  })

  // -------------------------------------------------------------------------
  // IPC：设置与缓存
  // -------------------------------------------------------------------------

  ctx.ipc.handle('settings/get', () => ({
    concurrency: String(maxConcurrency()),
    segments: normalizeDownloadSegments(
      ctx.storage.get<string>('segments', DEFAULT_DOWNLOAD_SEGMENTS)
    ),
    segmentThreshold: normalizeDownloadSegmentThreshold(
      ctx.storage.get<string>('segmentThreshold', DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD)
    ),
    cacheLimit: loadCacheLimit()
  }))

  ctx.ipc.handle<{ key: string; value: string }>('settings/set', async ({ key, value }) => {
    if (key === 'segments') {
      const normalized = normalizeDownloadSegments(value)
      ctx.storage.set('segments', normalized)
      log.info('单文件分段连接数已更新：%s', normalized)
      return
    }
    if (key === 'segmentThreshold') {
      const normalized = normalizeDownloadSegmentThreshold(value)
      ctx.storage.set('segmentThreshold', normalized)
      log.info('分段阈值已更新：%s MB', normalized)
      return
    }
    if (key === 'cacheLimit') {
      const normalized = normalizeDownloadCacheLimit(value)
      ctx.storage.set('cacheLimit', normalized)
      log.info('下载缓存上限已更新：%s', describeCacheLimit(normalized))
      await pruneCacheNow()
      return cacheUsage()
    }
    // 旧版页面的源配置：接受写入但只保存，供迁移读取；新页面不再调用
    if (key === 'sources' || key === 'loaderSources' || key === 'modSources') {
      ctx.storage.set(key, value)
      log.warn('%s 已改由各自的插件管理，本次写入仅保留用于迁移', key)
      return
    }
    ctx.storage.set(key, value)
    log.info('下载设置已更新：%s', key)
  })

  ctx.ipc.handle('cache/stats', () => cacheUsage())

  ctx.ipc.handle('cache/clear', async () => {
    const busy = [...tasks.values()].some(
      (task) => task.state === 'downloading' || task.state === 'verifying'
    )
    if (busy) throw new Error('正在下载，暂时不能清空缓存')
    const before = await cacheUsage()
    try {
      await rm(cacheRoot, { recursive: true, force: true })
    } catch (cause) {
      throw new Error(`清空缓存失败：${toError(cause).message}`, { cause })
    }
    log.info('下载缓存已清空：%d 个文件，%d 字节', before.files, before.bytes)
    return cacheUsage()
  })
}

export default defineMainPlugin({ name, inject, apply })
