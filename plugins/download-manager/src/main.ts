import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
  FILE_TRANSFER,
  INSTANCE_STATE_FILE,
  normalizeDownloadSources,
  validateInstanceName,
} from '@mics/sdk'
import type {
  DownloadSource,
  DownloadTask,
  FileTransferCapability,
  FileTransferHandle,
  InstallJob,
  InstallLiveState,
  InstallRepairRequest,
  InstanceInstallRecord,
  InstanceInstallStatus,
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
  const log = ctx.logger('mics.download.manager')
  const tasks = new Map<string, DownloadTask>()
  const jobs = new Map<string, InstallJob>()
  /** 正在传输的任务句柄：暂停/取消时用它中断请求（.part 保留） */
  const transfers = new Map<string, FileTransferHandle>()
  /** 每个任务当前下载轮次；暂停后立刻恢复时靠它丢弃上一轮的迟到回调 */
  const downloadRuns = new Map<string, number>()
  const cancelledTasks = new Set<string>()
  const cancelledJobs = new Set<string>()
  /** 正在写完成标记的安装：多个任务同时收尾时只允许一个去写 */
  const completingJobs = new Set<string>()
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
  log.info('file-transfer 能力已注册（provider=local）')

  /** 已受理但尚未落盘的实例名：并发提交同名安装时先占位 */
  const reservedInstanceNames = new Set<string>()

  /** Windows 文件名不区分大小写，重名判断也要一致 */
  function instanceKey(name: string): string {
    return process.platform === 'win32' ? name.toLowerCase() : name
  }

  function instanceDirOf(name: string): string {
    return path.join(dataDir, 'instances', name)
  }

  function versionJsonOf(name: string, gameVersion: string): string {
    return path.join(instanceDirOf(name), 'versions', gameVersion, `${gameVersion}.json`)
  }

  /**
   * 原子写入安装状态。
   *
   * 启动页只把 `ready` 当作可用实例，所以写入顺序不能反：先写临时文件再改名，
   * 任何时刻读者看到的要么是旧的完整 JSON，要么是新的完整 JSON。
   */
  async function writeInstallState(
    instanceDir: string,
    record: InstanceInstallRecord,
  ): Promise<void> {
    ensureDir(instanceDir)
    const target = path.join(instanceDir, INSTANCE_STATE_FILE)
    const temporary = `${target}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8')
      await rename(temporary, target)
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw cause
    }
  }

  function installRecordOf(job: InstallJob, state: InstanceInstallRecord['state']): InstanceInstallRecord {
    return {
      state,
      jobId: job.id,
      gameVersion: job.gameVersion,
      ...(state === 'ready' ? { completedAt: Date.now() } : {}),
    }
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

  /** IPC 参数里的实例名 / 版本 id 只接受单层安全名称 */
  function safeInstanceName(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const check = validateInstanceName(value)
    return check.ok && check.name === value ? value : null
  }

  function safeVersionId(value: unknown): string | null {
    if (typeof value !== 'string' || !value || value === '.' || value === '..') return null
    if (path.basename(value) !== value) return null
    return /[\\/:*?"<>|\u0000-\u001f]/.test(value) ? null : value
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
      log.warn(
        '下载源 #%d 的 %s 连续失败 %d 次，暂停使用 %d 分钟',
        sourceIndex + 1,
        category,
        SOURCE_FAILURE_LIMIT,
        Math.round(SOURCE_COOLDOWN / 60_000),
      )
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

  /** job id 的序号；旧记录没有 createdAt 时也能稳定排序 */
  function jobSequence(job: InstallJob): number {
    const sequence = Number(job.id.startsWith('job_') ? job.id.slice('job_'.length) : '')
    return Number.isFinite(sequence) ? sequence : (job.createdAt ?? 0)
  }

  /**
   * 同一实例名可能有多条安装记录（失败后重新安装、取消后重装）。
   * 只有最新的一条代表磁盘上的实例，旧记录只作为历史，不能再去改实例目录。
   */
  function latestJobFor(instanceName: string): InstallJob | undefined {
    let latest: InstallJob | undefined
    for (const job of jobs.values()) {
      if (job.instanceName !== instanceName) continue
      if (!latest || jobSequence(job) >= jobSequence(latest)) latest = job
    }
    return latest
  }

  function isCurrentJob(job: InstallJob): boolean {
    const latest = latestJobFor(job.instanceName)
    return !latest || latest.id === job.id
  }

  /**
   * 任务全部完成时给实例落 ready 标记。
   *
   * 只有标记写成功才把 job 记为完成：写失败时保持 ready 状态，下一次任务回调、
   * 下次启动的校正或用户重试都会再试一次，实例不会被误判为可用。
   */
  async function completeJob(job: InstallJob): Promise<void> {
    if (job.state === 'done' || completingJobs.has(job.id) || cancelledJobs.has(job.id)) return

    // 旧记录即使下完了也不能再写实例标记：同名的实例可能已经被新记录接管
    if (!isCurrentJob(job)) {
      job.state = 'done'
      delete job.error
      persistRecords(true)
      log.info('安装「%s」已完成，但记录已被更新的安装取代，job %s', job.instanceName, job.id)
      return
    }
    completingJobs.add(job.id)

    try {
      const instanceDir = instanceDirOf(job.instanceName)
      if (existsSync(instanceDir)) {
        // 实例可能在下载期间被用户从启动页删掉；没有版本文件就不能算安装完成
        if (!existsSync(versionJsonOf(job.instanceName, job.gameVersion))) {
          job.state = 'failed'
          job.error = '实例文件已被删除，安装未完成'
          log.warn('安装「%s」的实例文件已被删除，job %s 标记为失败', job.instanceName, job.id)
          persistRecords(true)
          return
        }
        try {
          await writeInstallState(instanceDir, installRecordOf(job, 'ready'))
        } catch (cause) {
          log.warn('写入实例「%s」的完成标记失败：%s', job.instanceName, toError(cause).message)
          return
        }
      }

      job.state = 'done'
      delete job.error
      persistRecords(true)
      log.info(
        '安装「%s」已完成：%d 个文件全部就绪，job %s',
        job.instanceName,
        job.taskIds.length,
        job.id,
      )
    } finally {
      completingJobs.delete(job.id)
    }
  }

  /**
   * 汇总一次安装的终态：任务全部完成 -> done；有失败且没有未结束任务 -> failed。
   * 还在下载/暂停的安装保持 ready，下载页继续展示为进行中。
   */
  async function settleJob(jobId: string): Promise<void> {
    const job = jobs.get(jobId)
    if (!job || job.state === 'done' || job.state === 'cancelled') return

    const list = job.taskIds.map((id) => tasks.get(id))
    if (list.length === 0 || list.length !== job.taskIds.length) return
    if (!list.every((task) => task?.state === 'done' || task?.state === 'failed')) return

    if (list.every((task) => task?.state === 'done')) {
      await completeJob(job)
      return
    }
    if (job.state === 'failed') return

    const failed = list.filter((task) => task?.state === 'failed').length
    job.state = 'failed'
    job.error = `${failed} 个文件下载失败，可重试或删除该安装`
    log.warn('安装「%s」未完成：%s，job %s', job.instanceName, job.error, job.id)
    persistRecords(true)
  }

  /** 把已完成实例的标记修复回 ready（不改变 job 状态，供启动校正使用） */
  async function ensureReadyMarker(job: InstallJob): Promise<void> {
    const instanceDir = instanceDirOf(job.instanceName)
    if (!existsSync(instanceDir)) return
    if (!existsSync(versionJsonOf(job.instanceName, job.gameVersion))) return
    try {
      await writeInstallState(instanceDir, installRecordOf(job, 'ready'))
    } catch (cause) {
      log.warn('修复实例「%s」的完成标记失败：%s', job.instanceName, toError(cause).message)
    }
  }

  /** 清理半成品实例目录：先写回 installing 再删，删除不完整时也不会暴露成可用实例 */
  async function discardInstanceDir(job: InstallJob): Promise<void> {
    const instanceDir = instanceDirOf(job.instanceName)
    if (!existsSync(instanceDir)) return

    await writeInstallState(instanceDir, installRecordOf(job, 'installing')).catch(() => undefined)
    try {
      await rm(instanceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    } catch (cause) {
      log.warn('清理安装「%s」的残留文件失败：%s', job.instanceName, toError(cause).message)
    }
  }

  /**
   * 启动时校正磁盘上的安装状态。
   *
   * 同一实例名可能残留多条历史记录，只有最新的一条能代表磁盘上的实例：
   * 按旧记录的状态去写标记，会把后来装好的实例重新标成未完成。
   *
   * - 最新记录已完成：修复/补写 ready；
   * - 最新记录仍未完成：补写 installing（启动页显示为未完成，不提供启动入口）；
   * - 已结束但未结算的旧记录补记 failed，下载页因此能提供重试。
   */
  async function reconcileInstalls(): Promise<void> {
    const latest = new Map<string, InstallJob>()
    for (const job of jobs.values()) {
      const current = latest.get(job.instanceName)
      if (!current || jobSequence(job) >= jobSequence(current)) latest.set(job.instanceName, job)
    }

    for (const job of latest.values()) {
      if (job.state === 'cancelled') continue

      if (job.state === 'done') {
        await ensureReadyMarker(job)
        continue
      }
      if (job.taskIds.length === 0) continue

      const list = job.taskIds.map((id) => tasks.get(id))
      if (list.length !== job.taskIds.length) continue

      if (list.every((task) => task?.state === 'done')) {
        await completeJob(job)
        continue
      }

      await settleJob(job.id)

      const instanceDir = instanceDirOf(job.instanceName)
      if (!existsSync(instanceDir)) continue
      try {
        await writeInstallState(instanceDir, installRecordOf(job, 'installing'))
      } catch (cause) {
        log.warn('校正实例「%s」的安装状态失败：%s', job.instanceName, toError(cause).message)
      }
    }
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
          void settleJob(task.installId)
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
      log.warn('下载失败 %s：所有下载源均已禁用', task.label ?? task.url)
      persistRecords()
      scheduleLoop()
      void settleJob(task.installId)
      return
    }
    const preferred = enabled.filter((index) => sourceAvailable(index, category))
    const order = preferred.length > 0 ? preferred : enabled

    try {
      ensureDir(path.dirname(task.savePath))
    } catch (cause) {
      task.state = 'failed'
      task.error = `无法创建下载目录：${toError(cause).message}`
      log.warn('下载失败 %s：%s', task.label ?? task.url, task.error)
      persistRecords()
      scheduleLoop()
      void settleJob(task.installId)
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
        log.warn('下载失败 %s（已尝试 %d 个源）：%s', task.label ?? task.url, order.length, task.error)
        persistRecords()
        scheduleLoop()
        void settleJob(task.installId)
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
          log.warn('下载失败 %s：%s', task.label ?? task.url, task.error)
          persistRecords()
          scheduleLoop()
          void settleJob(task.installId)
          return
        }
      }

      if (await dropCancelled(task, partPath)) return

      try {
        await rename(partPath, task.savePath)
      } catch (cause) {
        task.state = 'failed'
        task.error = `无法写入目标文件：${toError(cause).message}`
        log.warn('下载失败 %s：%s', task.label ?? task.url, task.error)
        persistRecords()
        scheduleLoop()
        void settleJob(task.installId)
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
      void settleJob(task.installId)
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

  /** 目标文件是否已存在且大小正确；补全时据此跳过已下载的文件 */
  async function fileMatchesSpec(spec: TaskSpec): Promise<boolean> {
    try {
      const info = await stat(spec.savePath)
      if (!info.isFile()) return false
      // 未知大小（0）时至少要求文件非空，避免把 0 字节残片当成已下载
      return spec.size > 0 ? info.size === spec.size : info.size > 0
    } catch {
      return false
    }
  }

  /** 并发筛掉已存在的文件，避免几千个资源对象串行 stat */
  async function onlyMissingSpecs(specs: TaskSpec[]): Promise<TaskSpec[]> {
    const present = new Array<boolean>(specs.length).fill(false)
    const workers = Math.min(32, specs.length)
    let cursor = 0

    await Promise.all(Array.from({ length: workers }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        const spec = specs[index]
        if (!spec) return
        present[index] = await fileMatchesSpec(spec)
      }
    }))

    return specs.filter((_, index) => !present[index])
  }

  /**
   * 读取资源索引：优先用实例里已有的副本（补全时通常已经下载过），
   * 缺失或损坏时再从下载源拉取并落盘。
   */
  async function loadAssetIndex(
    detail: MojangVersionDetail,
    indexPath: string,
    signal: AbortSignal,
  ): Promise<AssetIndex> {
    if (existsSync(indexPath)) {
      try {
        return JSON.parse(await readFile(indexPath, 'utf8')) as AssetIndex
      } catch { /* 索引损坏，重新下载 */ }
    }

    if (!detail.assetIndex?.url) throw new Error('版本缺少资源索引地址')
    const raw = (await fetchJsonFromSources(detail.assetIndex.url, signal)) as AssetIndex
    ensureDir(path.dirname(indexPath))
    await writeFile(indexPath, JSON.stringify(raw, null, 2))
    return raw
  }

  /** 把版本详情展开成下载清单；补全模式只保留目标文件缺失的项 */
  async function collectTaskSpecs(
    detail: MojangVersionDetail,
    versionsDir: string,
    gameVersion: string,
    signal: AbortSignal,
    options: { onlyMissing?: boolean } = {},
  ): Promise<TaskSpec[]> {
    const taskSpecs: TaskSpec[] = []

    // client.jar
    if (detail.downloads?.client) {
      const d = detail.downloads.client
      taskSpecs.push({
        label: `client.jar (${gameVersion})`,
        url: d.url,
        savePath: path.join(versionsDir, `${gameVersion}.jar`),
        sha1: d.sha1,
        size: d.size,
      })
    }

    // Libraries（常规 + native classifiers）
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

    // Asset index + objects
    if (detail.assetIndex) {
      const assetDir = path.join(versionsDir, 'assets')
      const indexPath = path.join(assetDir, 'indexes', `${detail.assets ?? gameVersion}.json`)
      const rawIndex = await loadAssetIndex(detail, indexPath, signal)

      for (const [, obj] of Object.entries(rawIndex.objects ?? {})) {
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

    // Logging config
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

    return options.onlyMissing ? onlyMissingSpecs(taskSpecs) : taskSpecs
  }

  /** 登记下载任务；安装与补全共用 */
  function enqueueTasks(job: InstallJob, specs: TaskSpec[], paused: boolean): void {
    for (const spec of specs) {
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
    log.info('开始准备安装「%s」（版本 %s，job %s）', job.instanceName, request.gameVersion, job.id)

    try {
      // 1. 安装状态：先落 installing 再写实例文件。启动页据此把它显示为
      //    「下载中」，完成（ready）之后才提供启动入口。
      createdInstance = true
      await writeInstallState(instanceDir, installRecordOf(job, 'installing'))
      if (isCancelled()) return

      const detail = await fetchVersionDetail(request.gameVersion, abort.signal)
      if (isCancelled()) return

      const versionsDir = path.join(instanceDir, 'versions', request.gameVersion)

      // 2. version.json
      ensureDir(versionsDir)
      await writeFile(
        path.join(versionsDir, `${request.gameVersion}.json`),
        JSON.stringify(detail, null, 2),
      )

      const taskSpecs = await collectTaskSpecs(
        detail,
        versionsDir,
        request.gameVersion,
        abort.signal,
      )
      if (isCancelled()) return

      // 任务先全部登记（缓存命中由下载循环判断），提交因此始终是常数级耗时
      const paused = pausedJobs.has(job.id)
      enqueueTasks(job, taskSpecs, paused)

      job.state = 'ready'
      log.info(
        '安装「%s」的下载清单已就绪：%d 个文件，job %s',
        job.instanceName,
        taskSpecs.length,
        job.id,
      )
      persistRecords(true)
      if (!paused) scheduleLoop()
    } catch (cause) {
      if (isCancelled()) return
      job.state = 'failed'
      job.error = toError(cause).message
      log.error('准备安装「%s」失败：%s', job.instanceName, job.error)
    } finally {
      prepAborts.delete(job.id)
      if (isCancelled()) {
        job.state = 'cancelled'
        log.info('安装「%s」已取消，job %s', job.instanceName, job.id)
      }
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

  /**
   * 补全已有实例：读取实例里的版本文件，只登记缺失文件的任务。
   *
   * 与安装不同，补全失败或取消不删除实例目录——用户只是还没补完，
   * 之后可以再点一次「补全文件」。
   */
  async function prepareRepair(job: InstallJob): Promise<void> {
    const instanceDir = instanceDirOf(job.instanceName)
    const abort = new AbortController()
    prepAborts.set(job.id, abort)
    const isCancelled = (): boolean => cancelledJobs.has(job.id)
    log.info('开始补全实例「%s」（版本 %s，job %s）', job.instanceName, job.gameVersion, job.id)

    try {
      const versionFile = versionJsonOf(job.instanceName, job.gameVersion)
      const detail = JSON.parse(await readFile(versionFile, 'utf8')) as MojangVersionDetail
      if (!detail?.id || !detail.mainClass) throw new Error('实例版本文件不完整')

      await writeInstallState(instanceDir, installRecordOf(job, 'installing'))
      if (isCancelled()) return

      const versionsDir = path.join(instanceDir, 'versions', job.gameVersion)
      const taskSpecs = await collectTaskSpecs(
        detail,
        versionsDir,
        job.gameVersion,
        abort.signal,
        { onlyMissing: true },
      )
      if (isCancelled()) return

      if (taskSpecs.length === 0) {
        if (isCancelled()) return
        await completeJob(job)
        return
      }

      const paused = pausedJobs.has(job.id)
      enqueueTasks(job, taskSpecs, paused)
      job.state = 'ready'
      log.info(
        '补全实例「%s」：需要下载 %d 个文件，job %s',
        job.instanceName,
        taskSpecs.length,
        job.id,
      )
      persistRecords(true)
      if (!paused) scheduleLoop()
    } catch (cause) {
      if (isCancelled()) return
      job.state = 'failed'
      job.error = toError(cause).message
      log.error('补全实例「%s」失败：%s', job.instanceName, job.error)
    } finally {
      prepAborts.delete(job.id)
      if (isCancelled()) {
        job.state = 'cancelled'
        pausedJobs.delete(job.id)
        log.info('补全实例「%s」已取消，job %s', job.instanceName, job.id)
      }
      persistRecords(true)
    }
  }

  loadRecords()
  if (jobs.size > 0 || tasks.size > 0) {
    log.info('下载记录已恢复：%d 个安装，%d 个下载任务', jobs.size, tasks.size)
  }
  void reconcileInstalls()

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
      log.info('下载源设置已更新')
      return
    }
    ctx.storage.set(key, value)
    log.info('下载设置已更新：%s', key)
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

  /** 汇总一次安装的实时阶段：准备 / 下载中 / 已暂停 / 失败 / 完成 */
  function liveStateOf(job: InstallJob): InstallLiveState {
    if (job.state === 'preparing') return pausedJobs.has(job.id) ? 'paused' : 'preparing'
    if (job.state === 'done') return 'done'
    if (job.state === 'cancelled') return 'cancelled'
    if (job.state === 'failed') return 'failed'

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
    const latest = new Map<string, InstallJob>()
    for (const job of jobs.values()) {
      const current = latest.get(job.instanceName)
      if (!current || jobSequence(job) >= jobSequence(current)) latest.set(job.instanceName, job)
    }

    return [...latest.values()].map((job) => ({
      instanceName: job.instanceName,
      jobId: job.id,
      state: liveStateOf(job),
      retryable: job.state === 'failed' && job.taskIds.some((taskId) => {
        const task = tasks.get(taskId)
        return task !== undefined && task.state === 'failed' && task.error !== '已取消'
      }),
    }))
  })

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
    log.info('取消安装「%s」，job %s', job.instanceName, job.id)
    // 准备阶段的安装没有任务，中断元数据请求后由 prepareJob 负责清理实例目录
    prepAborts.get(jobId)?.abort()
    await Promise.all(job.taskIds.map((taskId) => cancelTask(taskId)))
    // 取消的安装不保留半成品：清掉实例目录，名称可以立即重新使用。
    // 补全任务只停下载，实例本身要保留；旧记录也不能删掉新版实例的文件。
    if (isCurrentJob(job) && job.mode !== 'repair') await discardInstanceDir(job)
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/pause', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'failed' || job.state === 'cancelled') return
    // 任务级状态负责展示，任务级暂停集体生效；未开始的任务也要一起停下
    pausedJobs.add(jobId)
    log.info('暂停安装「%s」，job %s', job.instanceName, job.id)
    await Promise.all(job.taskIds.map((taskId) => pauseTask(taskId)))
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/resume', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'failed' || job.state === 'cancelled') return
    // 旧记录继续下载会写进新版实例的目录，直接拒绝
    if (!isCurrentJob(job)) return
    pausedJobs.delete(jobId)
    log.info('继续安装「%s」，job %s', job.instanceName, job.id)
    for (const taskId of job.taskIds) resumeTask(taskId)
    persistRecords(true)
    scheduleLoop()
  })

  /**
   * 重试一次失败的安装。
   *
   * 只把失败的任务重新排队，已完成的文件与下载缓存继续复用；实例在重试期间
   * 仍保持 installing，直到全部任务完成才重新变得可启动。
   */
  ctx.ipc.handle<{ jobId: string }>('install/retry', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job || job.state === 'done' || job.state === 'cancelled' || job.state === 'preparing') return
    if (!isCurrentJob(job)) throw new Error('该安装记录已被更新的安装取代，不能重试')
    if (job.taskIds.length === 0) throw new Error('该安装没有可续传的下载记录，请删除后重新安装')
    if (!existsSync(versionJsonOf(job.instanceName, job.gameVersion))) {
      throw new Error('实例版本文件已丢失，请删除该安装后重新下载')
    }

    const failed = job.taskIds
      .map((taskId) => tasks.get(taskId))
      .filter((task): task is DownloadTask => (
        task !== undefined && task.state === 'failed' && task.error !== '已取消'
      ))
    if (failed.length === 0) return

    await writeInstallState(instanceDirOf(job.instanceName), installRecordOf(job, 'installing'))
    job.state = 'ready'
    delete job.error
    pausedJobs.delete(job.id)
    for (const task of failed) {
      task.state = 'pending'
      delete task.error
      task.progress.loaded = partSizeOf(task.savePath)
      task.progress.total = task.size > 0 ? task.size : task.progress.total
      task.progress.speed = 0
    }

    log.info('重试安装「%s」：%d 个失败任务重新排队，job %s', job.instanceName, failed.length, job.id)
    persistRecords(true)
    scheduleLoop()
  })

  /**
   * 删除一次未完成安装留下的记录与残留目录。
   *
   * 已完成的安装必须到启动页删除，避免下载页把还能玩的实例一起删掉。
   */
  ctx.ipc.handle<{ jobId: string }>('install/discard', async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.state === 'done') throw new Error('安装已完成，请到启动页删除实例')
    if (!isCurrentJob(job)) throw new Error('该安装记录已被更新的安装取代，不能删除')

    const active = job.state === 'preparing' || job.taskIds.some((taskId) => {
      const task = tasks.get(taskId)
      return task !== undefined && task.state !== 'done' && task.state !== 'failed'
    })
    if (active) throw new Error('安装仍在进行，请先取消')

    // 补全任务只丢弃记录，实例目录留给启动页的「补全文件」继续处理
    if (job.mode !== 'repair') await discardInstanceDir(job)
    for (const taskId of job.taskIds) tasks.delete(taskId)
    jobs.delete(jobId)
    pausedJobs.delete(jobId)
    persistRecords(true)
    log.info('已删除安装记录「%s」，job %s', job.instanceName, job.id)
  })

  /**
   * 补全已有实例：从实例里的版本文件重建下载清单，只下载缺失文件。
   *
   * 补全不创建新实例，也不检查重名；调用方（启动页）传实例目录名和当前版本 id。
   */
  ctx.ipc.handle<InstallRepairRequest>('install/repair', (request) => {
    const instanceName = safeInstanceName(request?.instanceName)
    if (!instanceName) return { jobId: '', error: '无效的实例名称' }

    const versionId = safeVersionId(request?.versionId)
    if (!versionId) return { jobId: '', error: '无效的版本 id' }

    const instanceDir = instanceDirOf(instanceName)
    if (!existsSync(instanceDir)) return { jobId: '', error: '实例不存在' }
    if (!existsSync(versionJsonOf(instanceName, versionId))) {
      return { jobId: '', error: '实例版本文件不存在' }
    }

    // 已有进行中的任务时直接复用，避免同一实例并发下载
    const active = [...jobs.values()].find((job) => job.instanceName === instanceName
      && job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled')
    if (active) return { jobId: active.id }

    const job: InstallJob = {
      id: nextJobId(),
      instanceName,
      gameVersion: versionId,
      taskIds: [],
      createdAt: Date.now(),
      state: 'preparing',
      mode: 'repair',
    }
    jobs.set(job.id, job)
    persistRecords()
    log.info('已受理补全实例「%s」：版本 %s，job %s', instanceName, versionId, job.id)

    void prepareRepair(job).catch(() => undefined)
    return { jobId: job.id }
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
      mode: 'install',
    }
    jobs.set(job.id, job)

    // 从受理到版本目录落盘之间占住名称，避免同一名称的并发安装互相覆盖
    reservedInstanceNames.add(instanceKey(instanceName))
    // 不做同步落盘：任务列表可能有上千条，写入会拖慢「点击即返回」的受理路径
    persistRecords()
    log.info(
      '已受理安装「%s」：版本 %s，job %s',
      instanceName,
      request.gameVersion,
      job.id,
    )

    // 立刻返回：下载清单在后台准备，调用方直接跳转到下载页
    void prepareJob(job, request).catch(() => undefined)

    return { jobId: job.id }
  })
}

export default defineMainPlugin({ name, inject, apply })