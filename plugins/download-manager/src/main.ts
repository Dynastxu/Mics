import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import type { Context } from 'cordis'
import {
  defineMainPlugin,
  instanceClientJar,
  instanceVersionJson,
  instancesRoot,
  resolveInstanceLayout,
  sharedLibrariesDir,
} from '@mics/sdk/main'
import type { InstanceLayout } from '@mics/sdk/main'
import { findJava } from '@mics/java'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
  DEFAULT_LOADER_SOURCES,
  FILE_TRANSFER,
  INSTANCE_STATE_FILE,
  LOADER_LABELS,
  SHELL_EXECUTE,
  normalizeDownloadSources,
  normalizeLoaderSources,
  validateInstanceName,
} from '@mics/sdk'
import type {
  DownloadSource,
  DownloadTask,
  FileTransferCapability,
  FileTransferHandle,
  GameVersion,
  InstallJob,
  InstallJobStats,
  InstallJobSummary,
  InstallLiveState,
  InstallRepairRequest,
  InstanceInstallRecord,
  InstanceInstallStatus,
  InstanceNameCheck,
  InstallRequest,
  LoaderSource,
  LoaderSourceKind,
  LoaderVersion,
  ShellExecuteCapability,
  ShellProcess,
  TransferOutcome,
  TransferProgress,
} from '@mics/sdk'
import { createFileTransfer, type FileTransferOptions } from './transfer'
import { listLoaderVersions, prepareLoaderInstall, safeLoaderKind } from './loaders'
import { tailLastLine } from './loaders/fs'
import {
  absoluteUrl,
  enabledSourcesOf,
  matchLoaderUrl,
  metadataCandidates,
  sourceLabel,
} from './loaders/sources'
import type { LoaderEnvironment } from './loaders/types'
import { mergeVersion, stripClientChecksum, joinBase, mavenPath } from './version'
import type { VersionArtifact, VersionDetail, VersionLibrary } from './version'

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

type MojangArtifact = VersionArtifact
type MojangLibrary = VersionLibrary
type MojangVersionDetail = VersionDetail

/** Mojang 的版本类型 -> 共享契约里的类型 */
const VERSION_TYPE_MAP: Record<string, GameVersion['type']> = {
  release: 'release',
  snapshot: 'snapshot',
  old_alpha: 'old_alpha',
  old_beta: 'old_beta',
}

function mapVersionType(value: string): GameVersion['type'] {
  return VERSION_TYPE_MAP[value] ?? 'snapshot'
}

/**
 * 没有摘要的 jar（例如 Fabric profile 里的 fabric-loader 自身）只能做结构校验。
 *
 * 只看文件头不够：断点续传时服务端忽略 Range 会把完整文件追加到残缺的
 * `.part` 后面，文件仍以 `PK` 开头但中央目录偏移全部错位，启动时报
 * ClassNotFoundException。这里对齐 EOCD、中央目录与首个本地头。
 */
function isReadableJar(file: string): boolean {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return false
  }
  if (buffer.length < 22) return false

  const start = Math.max(0, buffer.length - 0xffff - 22)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return false

  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0 || cdOffset + 46 > buffer.length) return false
  if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) return false

  const localOffset = buffer.readUInt32LE(cdOffset + 42)
  return localOffset + 4 <= buffer.length
    && buffer.readUInt32LE(localOffset) === 0x04034b50
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

const OS_NAME = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux'
/** 文件名里使用的平台名与 rules 里的 os.name 不完全一致（macos / osx） */
const FILE_OS_NAME = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin' ? 'macos' : 'linux'
const ARCH_NAME = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86'

/** 版本文件里的系统规则 */
interface VersionRule {
  action?: string
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

/** 启动参数里可能用到的特性开关；下载阶段只关心默认值（全部关闭） */
const RULE_FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: true,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
}

/**
 * 版本文件里的 rules 是否允许当前平台。
 *
 * 安装与补全只应下载本机真正会用到的库：Linux / macOS / arm64 的 native
 * 在 Windows x64 上永远不会进 classpath，下载它们只会放大失败面。
 */
function rulesAllow(rules: unknown[] | undefined): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const entry of rules) {
    const rule = entry as VersionRule | null
    if (!rule || typeof rule !== 'object') continue
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) continue
      if (rule.os.arch && rule.os.arch !== ARCH_NAME) continue
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) continue
        } catch {
          continue
        }
      }
    }
    if (rule.features) {
      const matched = Object.entries(rule.features)
        .every(([key, value]) => RULE_FEATURES[key] === value)
      if (!matched) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

/**
 * native 文件的平台标记是否与当前平台一致。
 *
 * rules 只声明 os.name（windows-arm64 的条目甚至没写 arch），所以还要看
 * 文件名里的 classifier：`-natives-windows-arm64` 在 x64 上装不了，
 * 也不该下载。
 */
function artifactPlatformMatches(relative: string): boolean {
  const file = path.basename(relative).toLowerCase()
  if (!file.includes('-natives-')) return true
  if (!file.includes(`-natives-${FILE_OS_NAME}`)) return false
  if (file.includes('arm64') && ARCH_NAME !== 'arm64') return false
  if (file.includes('aarch_64') && ARCH_NAME !== 'arm64') return false
  if (file.includes('x86_64') && ARCH_NAME !== 'x86_64') return false
  if (file.includes('-x86') && !file.includes('x86_64') && ARCH_NAME !== 'x86') return false
  return true
}

/**
 * 下载管线统一的请求头。
 *
 * BMCLAPI 会把 maven / assets 请求 302 到 CERNET、NJU 等镜像节点，这些节点
 * 会直接拒绝没有 User-Agent 的请求（403）。加载器文件、安装器与元数据请求
 * 都从这里取同一份头，避免某条路径漏掉。
 */
function downloadHeaders(): Record<string, string> {
  return {
    'User-Agent': `Mics/${app.getVersion()}`,
    Accept: '*/*',
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** 是否是 Mojang 官方的版本清单地址（官方源不需要改写 piston 域名） */
function isOfficialLauncherMeta(value: string): boolean {
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
  return host === 'launchermeta.mojang.com'
}

/** 原版下载源的地址替换：只改 host，路径与协议保持原样 */
function remapVanillaUrl(url: string, src: DownloadSource): string {
  let result = url
  const launchermeta = src.launchermeta.trim()
  const libraries = src.libraries.trim()
  const resources = src.resources.trim()
  if (launchermeta) result = result.replaceAll('launchermeta.mojang.com', launchermeta)
  if (libraries) result = result.replaceAll('libraries.minecraft.net', libraries)
  if (resources) result = result.replaceAll('resources.download.minecraft.net', resources)

  // 镜像一般同时代理 piston-meta / piston-data，但这两个地址没有独立的设置项：
  // 只有源改写了版本清单地址（说明它不是官方源）时，才顺延使用同一个镜像地址；
  // 官方源的 launchermeta 不提供 piston 路径，不能替换。
  if (launchermeta && !isOfficialLauncherMeta(launchermeta)) {
    result = result
      .replaceAll('piston-meta.mojang.com', launchermeta)
      .replaceAll('piston-data.mojang.com', launchermeta)
  }
  return result
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
  /** 加载器版本列表缓存：官方源响应慢时避免每次切加载器都重新请求 */
  const loaderVersionCache = new Map<string, { at: number; versions: LoaderVersion[] }>()
  const LOADER_VERSION_TTL = 5 * 60 * 1000

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
    return path.join(instancesRoot(dataDir), name)
  }

  function versionJsonOf(name: string, gameVersion: string): string {
    return instanceVersionJson(instanceDirOf(name), gameVersion)
  }

  /** 安装实际落盘的版本 id：加载器安装与游戏版本不同，旧记录回退到 gameVersion */
  function installedVersionId(job: InstallJob): string {
    return job.versionId ?? job.gameVersion
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

  type SourceCategory = 'meta' | 'libraries' | 'assets' | 'loader-meta' | 'other'
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

  function healthKey(key: string, category: SourceCategory): string {
    return `${key}#${category}`
  }

  function sourceAvailable(key: string, category: SourceCategory): boolean {
    const health = sourceHealth.get(healthKey(key, category))
    if (!health?.disabledUntil) return true
    if (health.disabledUntil > Date.now()) return false
    sourceHealth.delete(healthKey(key, category))
    return true
  }

  function reportSource(
    key: string,
    category: SourceCategory,
    success: boolean,
    label: string,
  ): void {
    const healthKeyOf = healthKey(key, category)
    if (success) {
      const health = sourceHealth.get(healthKeyOf)
      if (health && !health.disabledUntil) sourceHealth.delete(healthKeyOf)
      return
    }

    const health = sourceHealth.get(healthKeyOf) ?? { failures: 0, disabledUntil: 0 }
    health.failures += 1
    if (health.failures >= SOURCE_FAILURE_LIMIT) {
      health.failures = 0
      health.disabledUntil = Date.now() + SOURCE_COOLDOWN
      log.warn(
        '下载源「%s」的 %s 连续失败 %d 次，暂停使用 %d 分钟',
        label,
        category,
        SOURCE_FAILURE_LIMIT,
        Math.round(SOURCE_COOLDOWN / 60_000),
      )
    }
    sourceHealth.set(healthKeyOf, health)
  }

  function loadSources(): DownloadSource[] {
    try {
      const raw = ctx.storage.get<string>('sources', '')
      if (raw) return normalizeDownloadSources(JSON.parse(raw))
    } catch { /* fall through */ }
    return normalizeDownloadSources(DEFAULT_DOWNLOAD_SOURCES)
  }

  function loadLoaderSources(): LoaderSource[] {
    try {
      const raw = ctx.storage.get<string>('loaderSources', '')
      if (raw) return normalizeLoaderSources(JSON.parse(raw))
    } catch { /* fall through */ }
    return normalizeLoaderSources(DEFAULT_LOADER_SOURCES)
  }

  /** 参与下载的原版源下标（保持优先级顺序） */
  function enabledSourceIndexes(sources: DownloadSource[]): number[] {
    const indexes: number[] = []
    for (let index = 0; index < sources.length; index++) {
      if (sources[index]?.enabled !== false) indexes.push(index)
    }
    return indexes
  }

  interface DownloadCandidate {
    /** 健康度记录键：同一份文件换源时各源独立冷却 */
    key: string
    label: string
    url: string
    category: SourceCategory
  }

  /**
   * 一个下载地址的全部候选地址。
   *
   * 原版地址按原版下载源重写；加载器地址按对应类型的加载器源重写。
   * 加载器镜像返回的绝对地址也能命中（matchLoaderUrl 同时匹配已配置的基址）。
   */
  function downloadCandidates(url: string): DownloadCandidate[] {
    const loaderSources = loadLoaderSources()
    const loaderMatch = matchLoaderUrl(url, loaderSources)
    const candidates: DownloadCandidate[] = []
    const seen = new Set<string>()

    const add = (
      key: string,
      label: string,
      candidateUrl: string,
      category: SourceCategory,
    ): void => {
      if (!candidateUrl || seen.has(candidateUrl)) return
      seen.add(candidateUrl)
      candidates.push({ key, label, url: candidateUrl, category })
    }

    if (loaderMatch) {
      const category: SourceCategory = loaderMatch.role === 'meta' ? 'loader-meta' : 'other'
      loaderSources.forEach((source, index) => {
        if (!source.enabled || source.kind !== loaderMatch.kind) return
        const base = loaderMatch.role === 'maven' ? source.maven : source.meta
        add(
          `loader:${source.kind}:${index}`,
          sourceLabel(source, index),
          absoluteUrl(base, loaderMatch.suffix),
          category,
        )
      })
      return candidates
    }

    const sources = loadSources()
    const category = sourceCategory(url)
    for (const index of enabledSourceIndexes(sources)) {
      const source = sources[index]
      if (!source) continue
      add(
        `vanilla:${index}`,
        source.label.trim() || `源 ${index + 1}`,
        remapVanillaUrl(url, source),
        category,
      )
    }
    return candidates
  }

  function cachePath(sha1: string): string {
    return path.join(cacheRoot, sha1.slice(0, 2), sha1.slice(2))
  }

  /**
   * 无摘要文件的缓存键：按 URL 归档。
   *
   * 加载器安装器 jar 没有 sha1（发布方不提供），但同一版本的下载地址不变，
   * 按 URL 缓存可以让「取消 / 失败后重试」不必再下几十 MB。
   */
  function urlCachePath(url: string): string {
    const key = createHash('sha1').update(url).digest('hex')
    return path.join(cacheRoot, 'url', key.slice(0, 2), key)
  }

  /** 缓存里的文件能否直接复用：有摘要按摘要，没有摘要时至少要是完整的 jar */
  async function cachedFileUsable(file: string, sha1: string, target: string): Promise<boolean> {
    let info
    try {
      info = await stat(file)
    } catch {
      return false
    }
    if (!info.isFile() || info.size === 0) return false
    if (sha1) return await hashFile(file) === sha1
    return !target.toLowerCase().endsWith('.jar') || isReadableJar(file)
  }

  /** 计算文件的 SHA1；读失败时返回 null（按不可用处理） */
  function hashFile(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash('sha1')
      const stream = createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk as Buffer))
      stream.on('error', () => resolve(null))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
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
        job.note = undefined
        job.preparePercent = undefined
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

    // 迁移旧记录：终态安装的逐文件任务只占空间，历史页读 job.stats 即可。
    // 被新安装取代的失败记录既不能重试也不能删除，同样没有保留明细的理由。
    for (const job of jobs.values()) {
      if (job.state === 'done' || job.state === 'cancelled') {
        archiveJob(job)
      } else if (job.state === 'failed' && !isCurrentJob(job)) {
        archiveJob(job)
      }
    }

    if (jobs.size > 0 || raw.jobs.length > 0) persistRecords(true)
  }

  /** job id 的序号；旧记录没有 createdAt 时也能稳定排序 */
  function jobSequence(job: InstallJob): number {
    const sequence = Number(job.id.startsWith('job_') ? job.id.slice('job_'.length) : '')
    return Number.isFinite(sequence) ? sequence : (job.createdAt ?? 0)
  }

  /** 遍历任务并汇总一次安装；任务明细缺失时按实际存在的部分计算 */
  function collectStats(job: InstallJob): InstallJobStats {
    let total = 0
    let waiting = 0
    let paused = 0
    let downloading = 0
    let done = 0
    let failed = 0
    let cancelled = 0
    let loaded = 0
    let bytes = 0

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
      bytes += task.progress.total > 0 ? task.progress.total : Math.max(task.size, 0)
    }

    const measured = bytes > 0
      ? (loaded / bytes) * 100
      : total > 0
        ? ((done + failed) / total) * 100
        : 0

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
      percent: Math.min(100, Math.max(0, Math.round(measured))),
    }
  }

  function statsOf(job: InstallJob): InstallJobStats {
    // 已归档的终态安装没有任务明细，直接复用落盘的汇总
    if (job.taskIds.length === 0 && job.stats) return job.stats
    return collectStats(job)
  }

  function isFinishedJob(job: InstallJob, stats: InstallJobStats): boolean {
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return true
    if (job.state === 'preparing') return false
    return stats.total === 0 || stats.done + stats.failed === stats.total
  }

  /**
   * 归档终态安装：保留汇总计数，删掉逐文件任务。
   *
   * 一次安装通常有几千个任务（资源对象占大头），历史记录全部保留会让下载页
   * 每次轮询都搬运几十 MB。已完成 / 已取消 / 被取代的安装不再需要这些明细：
   * 历史行只显示汇总，重试也只针对当前失败记录。
   */
  function archiveJob(job: InstallJob): void {
    if (job.taskIds.length === 0) {
      if (!job.stats) job.stats = collectStats(job)
      return
    }
    job.stats = collectStats(job)
    for (const taskId of job.taskIds) tasks.delete(taskId)
    job.taskIds = []
  }

  /** 新安装接手实例名后，旧终态记录既不能重试也不能删除，明细可以立刻归档 */
  function archiveSupersededJobs(instanceName: string, currentJobId: string): void {
    for (const job of jobs.values()) {
      if (job.id === currentJobId || job.instanceName !== instanceName) continue
      if (job.state === 'done' || job.state === 'cancelled' || job.state === 'failed') {
        archiveJob(job)
      }
    }
  }

  function toSummary(job: InstallJob): InstallJobSummary {
    const stats = statsOf(job)
    return {
      id: job.id,
      instanceName: job.instanceName,
      gameVersion: job.gameVersion,
      loader: job.loader,
      mode: job.mode,
      state: job.state ?? 'ready',
      error: job.error,
      note: job.note,
      preparePercent: job.preparePercent,
      createdAt: job.createdAt,
      finished: isFinishedJob(job, stats),
      stats,
    }
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
      archiveJob(job)
      persistRecords(true)
      log.info('安装「%s」已完成，但记录已被更新的安装取代，job %s', job.instanceName, job.id)
      return
    }
    completingJobs.add(job.id)

    try {
      const instanceDir = instanceDirOf(job.instanceName)
      if (existsSync(instanceDir)) {
        // 实例可能在下载期间被用户从启动页删掉；没有版本文件就不能算安装完成
        if (!existsSync(versionJsonOf(job.instanceName, installedVersionId(job)))) {
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
      const fileCount = job.taskIds.length
      archiveJob(job)
      persistRecords(true)
      log.info(
        '安装「%s」已完成：%d 个文件全部就绪，job %s',
        job.instanceName,
        fileCount,
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
    if (!existsSync(versionJsonOf(job.instanceName, installedVersionId(job)))) return
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
      if (job.taskIds.length === 0) {
        // 清单为空、状态却是 ready：文件本来就不缺，这同样是一次装好的安装
        if ((job.state ?? 'ready') === 'ready') await completeJob(job)
        continue
      }

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

  /** 元数据文本请求：跟随重定向，复用 keep-alive 连接 */
  function requestText(url: string, signal: AbortSignal, redirects = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      if (redirects > 8) {
        reject(new Error('重定向次数过多'))
        return
      }
      const secure = url.startsWith('https')
      const proto = secure ? https : http
      const req = proto.get(url, {
        signal,
        headers: downloadHeaders(),
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
          requestText(next, signal, redirects + 1).then(resolve, reject)
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
        res.on('end', () => resolve(data))
        res.on('error', reject)
      })

      req.setTimeout(10_000, () => req.destroy(new Error('请求超时')))
      req.on('error', reject)
    })
  }

  /**
   * 在所有候选地址上并行请求同一份元数据，最先成功的返回。
   *
   * 串行重试时，一个不可达的源会把「点击安装」拖住整整一个超时周期；
   * 并行后慢源不再影响结果，取消安装时也能立刻中断所有请求。
   */
  async function firstSuccessful<T>(
    targets: string[],
    signal: AbortSignal | undefined,
    parse: (text: string) => T,
    emptyMessage = '未启用任何下载源',
  ): Promise<T> {
    if (targets.length === 0) throw new Error(emptyMessage)

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
      return Promise.race([requestText(target, controller.signal).then(parse), timeout])
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

  async function fetchJsonFromSources(url: string, signal?: AbortSignal): Promise<unknown> {
    const targets = downloadCandidates(url).map((candidate) => candidate.url)
    return firstSuccessful(targets, signal, (text) => JSON.parse(text) as unknown)
  }

  /**
   * 与 `fetchJsonFromSources` 相同，但返回原始文本。
   *
   * 用于必须原样落盘、之后要按 sha1 校验的文件（资源索引）：解析后再序列化会
   * 改变字节，摘要校验必然失败。
   */
  async function fetchTextFromSources(url: string, signal?: AbortSignal): Promise<string> {
    const targets = downloadCandidates(url).map((candidate) => candidate.url)
    return firstSuccessful(targets, signal, (text) => text)
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

  /** 加载器元数据请求：只在同类型的加载器源之间回退 */
  function fetchLoaderText(
    sources: LoaderSource[],
    kind: LoaderSourceKind,
    path: string,
    role: 'meta' | 'maven' = 'meta',
    signal?: AbortSignal,
  ): Promise<string> {
    return firstSuccessful(
      metadataCandidates(sources, kind, path, role),
      signal,
      (text) => text,
      `未启用任何 ${LOADER_LABELS[kind]} 下载源`,
    )
  }

  /**
   * 直接下载一个必需文件（安装器、客户端 jar），不进入任务队列。
   *
   * 准备阶段必须先把这些文件拿到才能继续，所以这里**同时向所有可用源发起请求**，
   * 谁先下完用谁的：官方 maven 在国内常常只有几 KB/s，而镜像可能早就下完了，
   * 串行等慢源会让「准备下载清单」看起来像卡死。落败的源立即停止，各自写的
   * `.part<序号>` 也一并清掉，不会污染目标文件。
   */
  async function downloadFileNow(
    url: string,
    target: string,
    sha1 = '',
    size = 0,
    signal?: AbortSignal,
    onProgress?: (progress: TransferProgress) => void,
  ): Promise<void> {
    const candidates = downloadCandidates(url)
    if (candidates.length === 0) throw new Error('没有可用的下载源')
    if (signal?.aborted) throw new Error('已取消')

    // 以前这里只写缓存不读缓存：取消一次重试就得把安装器、依赖库重新下一遍
    const cached = sha1 ? cachePath(sha1) : urlCachePath(url)
    if (await cachedFileUsable(cached, sha1, target)) {
      ensureDir(path.dirname(target))
      await copyFile(cached, target)
      onProgress?.({ loaded: 1, total: 1 })
      return
    }
    await rm(cached, { force: true }).catch(() => undefined)

    ensureDir(path.dirname(target))

    const transfers: FileTransferHandle[] = []
    const partPaths: string[] = []
    const failures: Error[] = []
    let settled = false
    /** 进度取各源里最大的那个：多个源同时下，不能让进度条来回跳 */
    let reported = 0

    // 取消安装时立刻掐断所有在途请求，而不是等它们跑完
    const abortAll = (): void => {
      for (const handle of transfers) void handle.stop().catch(() => undefined)
    }
    signal?.addEventListener('abort', abortAll, { once: true })

    const attempt = async (candidate: DownloadCandidate, index: number): Promise<void> => {
      const partPath = `${target}.part${index}`
      partPaths.push(partPath)
      const transfer = ctx.capabilities.require<FileTransferCapability>(FILE_TRANSFER).create({
        url: candidate.url,
        partPath,
        sha1,
        size,
        headers: downloadHeaders(),
        agents: { http: httpAgent, https: httpsAgent },
        onProgress: (progress) => {
          if (settled || progress.loaded <= reported) return
          reported = progress.loaded
          onProgress?.(progress)
        },
      })
      transfers.push(transfer)

      let outcome: TransferOutcome
      try {
        outcome = await transfer.start()
      } catch (cause) {
        outcome = { status: 'failed', error: toError(cause) }
      }

      if (settled) throw new Error('已有更快的源完成')
      if (signal?.aborted) throw new Error('已取消')
      if (outcome.status !== 'done') {
        throw outcome.error ?? new Error(`${candidate.label} 下载失败`)
      }
      if (sha1 && outcome.digest !== sha1) {
        throw new Error(`${candidate.label} 下载的文件校验失败`)
      }

      settled = true
      try {
        await rename(partPath, target)
        if (!sha1 && target.toLowerCase().endsWith('.jar') && !isReadableJar(target)) {
          // 安装器 / 无摘要文件：拒绝截断或错误页，让其它源继续竞争
          await rm(target, { force: true }).catch(() => undefined)
          throw new Error(`${candidate.label} 下载的文件不是有效的 jar`)
        }
      } catch (cause) {
        settled = false
        throw toError(cause)
      }

      const cacheTarget = sha1 ? cachePath(sha1) : urlCachePath(url)
      if (!existsSync(cacheTarget)) {
        try {
          ensureDir(path.dirname(cacheTarget))
          await copyFile(target, cacheTarget)
        } catch { /* 缓存只是加速手段 */ }
      }
    }

    try {
      await Promise.any(
        candidates.map((candidate, index) =>
          attempt(candidate, index).catch((cause: unknown) => {
            const error = toError(cause)
            failures.push(error)
            throw error
          }),
        ),
      )
    } catch (cause) {
      if (signal?.aborted) throw new Error('已取消')
      throw failures[0] ?? toError(cause)
    } finally {
      signal?.removeEventListener('abort', abortAll)
      await Promise.all(transfers.map((handle) => handle.stop().catch(() => undefined)))
      for (const partPath of partPaths) {
        if (!existsSync(partPath)) continue
        await rm(partPath, { force: true }).catch(() => undefined)
      }
    }
  }

  /** 运行 Java 进程并等待退出；取消时结束进程 */
  function runJavaProcess(
    spec: { args: string[]; cwd: string; logFile: string; requiredMajor: number },
    signal?: AbortSignal,
    options: { stallMs?: number } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('已取消'))
        return
      }

      let javaPath: string
      try {
        javaPath = findJava(spec.requiredMajor).java
      } catch (cause) {
        reject(toError(cause))
        return
      }

      ensureDir(path.dirname(spec.logFile))
      log.info('使用 Java 运行进程：%s %s', javaPath, spec.args[0] ?? '')
      const shell = ctx.capabilities.require<ShellExecuteCapability>(SHELL_EXECUTE)
      let child: ShellProcess | null = null
      let settled = false
      let watcher: NodeJS.Timeout | null = null
      const stallMs = options.stallMs ?? 0
      let lastSize = -1
      let lastGrowth = Date.now()

      function settle(error?: Error): void {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (watcher) {
          clearInterval(watcher)
          watcher = null
        }
        if (error) reject(error)
        else resolve()
      }

      function onAbort(): void {
        child?.kill()
        settle(new Error('已取消'))
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      // 安装器没有任何进度接口：日志长时间不增长就认为它已经卡死，
      // 结束进程并把日志交给上层展示，而不是无限等下去。
      if (stallMs > 0) {
        watcher = setInterval(() => {
          let size = 0
          try {
            size = statSync(spec.logFile).size
          } catch { /* 还没写出日志 */ }
          if (size !== lastSize) {
            lastSize = size
            lastGrowth = Date.now()
            return
          }
          if (Date.now() - lastGrowth < stallMs) return
          child?.kill()
          settle(new Error(
            `安装器 ${Math.round(stallMs / 1000)} 秒没有任何输出，已终止（日志：${spec.logFile}）`,
          ))
        }, 5000)
      }

      void shell
        .spawn({ command: javaPath, args: spec.args, cwd: spec.cwd, logFile: spec.logFile })
        .then((process) => {
          if (settled) {
            process.kill()
            return
          }
          child = process
          process.once('exit', (...args) => {
            const code = args[0]
            if (typeof code === 'number' && code !== 0) settle(new Error(`安装器退出码 ${code}`))
            else settle()
          })
        })
        .catch((cause) => settle(toError(cause)))
    })
  }

  function createLoaderEnvironment(
    kind: LoaderSourceKind,
    signal: AbortSignal,
    report?: (note: string, percent?: number) => void,
  ): LoaderEnvironment {
    const sources = enabledSourcesOf(loadLoaderSources(), kind)
    /** 加载器自己的日志文本就是「当前步骤」 */
    let step = ''

    const publish = (loaded?: number, total?: number): void => {
      if (!report || !step) return
      if (loaded === undefined || total === undefined) {
        report(step)
        return
      }
      if (total > 0) report(step, (loaded / total) * 100)
      else report(`${step} ${(loaded / 1048576).toFixed(1)} MB`)
    }

    return {
      signal,
      sources,
      report: (note: string, percent?: number) => {
        report?.(note, percent)
      },
      log: (level, message) => {
        if (level === 'warn') log.warn('[%s] %s', LOADER_LABELS[kind], message)
        else log.info('[%s] %s', LOADER_LABELS[kind], message)
        if (level === 'info') {
          step = message
          publish()
        }
      },
      fetchText: (path, role = 'meta') => fetchLoaderText(sources, kind, path, role, signal),
      fetchJson: <T>(path: string, role: 'meta' | 'maven' = 'meta'): Promise<T> => {
        return fetchLoaderText(sources, kind, path, role, signal)
          .then((text) => JSON.parse(text) as T)
      },
      fetchJsonUrl: <T>(url: string): Promise<T> => {
        return firstSuccessful([url], signal, (text) => JSON.parse(text) as T)
      },
      download: (url, target, sha1 = '', size = 0, options = {}) =>
        downloadFileNow(
          url,
          target,
          sha1,
          size,
          signal,
          options.reportProgress === false ? undefined : ({ loaded, total }) => publish(loaded, total),
        ),
      runJava: async (spec) => {
        publish()
        // 安装器没有进度接口：把它的日志末行和已用时间报给界面，同时用停滞超时兜底
        const started = Date.now()
        let lastLine = ''
        const timer = setInterval(() => {
          void tailLastLine(spec.logFile).then((line) => {
            if (line) lastLine = line
            const seconds = Math.floor((Date.now() - started) / 1000)
            const detail = lastLine ? `：${lastLine}` : ''
            report?.(`${step || '运行安装器'}（已 ${seconds} 秒）${detail}`)
          }).catch(() => undefined)
        }, 1500)
        try {
          await runJavaProcess(spec, signal, { stallMs: 180_000 })
        } finally {
          clearInterval(timer)
        }
      },
    }
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

    // 库与资源现在放在共享目录：另一个实例已经装过的文件直接复用，
    // 不必再走一遍下载或缓存复制。
    if (await fileMatchesSpec(task)) {
      if (!current()) return
      task.progress.loaded = task.size
      task.progress.total = task.size
      task.state = 'done'
      persistRecords()
      scheduleLoop()
      void settleJob(task.installId)
      return
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

    const candidates = downloadCandidates(task.url)
    if (candidates.length === 0) {
      task.state = 'failed'
      task.error = '所有下载源均已禁用'
      task.progress.speed = 0
      log.warn('下载失败 %s：所有下载源均已禁用', task.label ?? task.url)
      persistRecords()
      scheduleLoop()
      void settleJob(task.installId)
      return
    }
    const preferred = candidates.filter((candidate) =>
      sourceAvailable(candidate.key, candidate.category),
    )
    const order = preferred.length > 0 ? preferred : candidates

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
      const candidate = order[ci]
      if (!candidate) continue

      if (!current()) return
      if (await dropCancelled(task, partPath)) return
      if (pausedNow()) {
        settlePaused()
        return
      }

      const transfer = ctx.capabilities.require<FileTransferCapability>(FILE_TRANSFER).create({
        url: candidate.url,
        partPath,
        sha1: task.sha1,
        // 没有摘要的文件不做断点续传：服务端忽略 Range 时会把完整文件追加到
        // 残缺的 .part 后面，得到结构损坏却「下载完成」的文件
        size: task.sha1 && task.size > 0 ? task.size : 0,
        headers: downloadHeaders(),
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
        reportSource(candidate.key, candidate.category, false, candidate.label)
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
          reportSource(candidate.key, candidate.category, false, candidate.label)
          if (ci < order.length - 1) continue
          task.state = 'failed'
          task.error = `SHA1 校验失败：期望 ${task.sha1}，实际 ${result.digest ?? '未知'}`
          log.warn('下载失败 %s：%s', task.label ?? task.url, task.error)
          persistRecords()
          scheduleLoop()
          void settleJob(task.installId)
          return
        }
      } else if (
        task.savePath.toLowerCase().endsWith('.jar')
        && !isReadableJar(partPath)
      ) {
        // 没有摘要的 jar 也要拒绝镜像的错误页 / 空文件
        await rm(partPath, { force: true }).catch(() => undefined)
        reportSource(candidate.key, candidate.category, false, candidate.label)
        if (ci < order.length - 1) continue
        task.state = 'failed'
        task.error = '下载的文件不是有效的 jar'
        log.warn('下载失败 %s：%s', task.label ?? task.url, task.error)
        persistRecords()
        scheduleLoop()
        void settleJob(task.installId)
        return
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

      reportSource(candidate.key, candidate.category, true, candidate.label)
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
    // 缓存可能来自旧版下载器，也可能是写坏的条目；复制前必须按文件名重新校验，
    // 否则坏内容会被当成「已下载」装进每个实例，补全也永远修不好。
    if (await hashFile(cached) !== task.sha1) {
      await rm(cached, { force: true }).catch(() => undefined)
      log.warn('下载缓存内容与摘要不符，已丢弃：%s', task.sha1)
      return false
    }
    ensureDir(path.dirname(task.savePath))
    await copyFile(cached, task.savePath)
    return true
  }

  /** 目标文件是否已完整；补全时据此跳过已下载的文件 */
  async function fileMatchesSpec(spec: TaskSpec): Promise<boolean> {
    try {
      const info = await stat(spec.savePath)
      if (!info.isFile()) return false

      // 有摘要时必须校验内容：大小相同但内容损坏的文件（旧缓存、镜像错误页）
      // 只看大小会被判成「已下载」，补全永远修不好，启动又一直提示缺失。
      if (spec.sha1) {
        if (spec.size > 0 && info.size !== spec.size) return false
        return await hashFile(spec.savePath) === spec.sha1
      }

      // 已知大小、没有摘要时按大小判断；未知大小至少要求非空
      if (spec.size > 0) return info.size === spec.size
      // 没有摘要/大小的 jar 只能做结构校验，避免把截断文件当成已下载
      if (spec.savePath.toLowerCase().endsWith('.jar')) {
        return isReadableJar(spec.savePath)
      }
      return info.size > 0
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
   * 读取资源索引：优先用已有的副本（补全时通常已经下载过），缺失或内容与摘要
   * 不符时再从下载源拉取。
   *
   * 落盘必须是**原文**：启动前会按 `assetIndex.sha1` 校验这个文件，用
   * `JSON.stringify` 重新序列化会改变字节（缩进），摘要永远对不上——表现就是
   * 「补全成功但启动仍提示缺少资源索引」。
   */
  async function loadAssetIndex(
    detail: MojangVersionDetail,
    indexPath: string,
    signal: AbortSignal,
  ): Promise<AssetIndex> {
    const expectedSha1 = detail.assetIndex?.sha1
    if (await assetIndexIsUsable(indexPath, expectedSha1)) {
      try {
        return JSON.parse(await readFile(indexPath, 'utf8')) as AssetIndex
      } catch { /* 索引损坏，重新下载 */ }
    }

    if (!detail.assetIndex?.url) throw new Error('版本缺少资源索引地址')
    const text = await fetchTextFromSources(detail.assetIndex.url, signal)
    const raw = JSON.parse(text) as AssetIndex
    ensureDir(path.dirname(indexPath))
    await writeFile(indexPath, text)

    // 镜像若重新编码过 JSON，摘要仍会不符；写下去也没用，至少要留下线索
    if (expectedSha1 && await hashFile(indexPath) !== expectedSha1) {
      log.warn('资源索引与版本文件里的摘要不符（可能来自镜像）：%s', indexPath)
    }
    return raw
  }

  /** 已有索引是否可信：有摘要按摘要比对，没有摘要时只要求文件存在 */
  async function assetIndexIsUsable(file: string, expectedSha1: string | undefined): Promise<boolean> {
    let info
    try {
      info = await stat(file)
    } catch {
      return false
    }
    if (!info.isFile()) return false
    if (!expectedSha1) return true
    try {
      return await hashFile(file) === expectedSha1
    } catch {
      return false
    }
  }

  /** 把版本详情展开成下载清单；补全模式只保留目标文件缺失的项 */
  async function collectTaskSpecs(
    detail: MojangVersionDetail,
    layout: InstanceLayout,
    gameVersion: string,
    signal: AbortSignal,
    options: { onlyMissing?: boolean } = {},
  ): Promise<TaskSpec[]> {
    const taskSpecs: TaskSpec[] = []

    // client.jar
    const clientArtifact = detail.downloads?.client
    if (clientArtifact?.url) {
      taskSpecs.push({
        label: `client.jar (${gameVersion})`,
        url: clientArtifact.url,
        savePath: instanceClientJar(layout.instanceDir, gameVersion),
        sha1: clientArtifact.sha1 ?? '',
        size: clientArtifact.size ?? 0,
      })
    }

    // Libraries（常规 + native classifiers）
    for (const lib of detail.libraries ?? []) {
      // 只下载本机会用到的库；跨平台 native 既不进 classpath，也不该占下载清单
      if (!rulesAllow(lib.rules)) continue

      const artifacts: MojangArtifact[] = []
      if (lib.downloads?.artifact) artifacts.push(lib.downloads.artifact)
      // 旧版 profile 只给 name + 仓库基址：补全时按 maven 规则拼出地址，
      // 否则这些库永远不会下载
      if (!lib.downloads?.artifact && lib.url) {
        const relative = mavenPath(lib.name)
        artifacts.push({
          url: joinBase(lib.url, relative),
          path: relative,
          sha1: lib.sha1,
          size: lib.size,
        })
      }

      if (lib.downloads?.classifiers) {
        for (const [classifier, art] of Object.entries(lib.downloads.classifiers)) {
          const classifierOs = classifier.replace('natives-', '')
          if (classifierOs === 'windows' || classifierOs.startsWith('natives-windows')) {
            artifacts.push(art)
          }
        }
      }

      for (const art of artifacts) {
        const artifactUrl = art.url ?? ''
        if (!artifactUrl) continue
        const libParts = lib.name.split(':')
        const libFile = libParts.length >= 3
          ? `${libParts[1]}-${libParts[2]}${artifactUrl.includes('natives') ? '-' + (artifactUrl.match(/natives-[^/]+/)?.[0] ?? '') : ''}.jar`
          : `${lib.name.replace(/:/g, '/')}.jar`
        const libDir = libParts.length >= 3
          ? path.join(libParts[0]!.replace(/\./g, '/'), libParts[1]!, libParts[2]!)
          : path.dirname(lib.name.replace(/:/g, '/'))
        const relative = art.path ?? path.join(libDir, libFile)
        // rules 常常不写 arch，文件名里的 classifier 才是最终依据
        if (!artifactPlatformMatches(relative)) continue

        taskSpecs.push({
          label: lib.name,
          url: artifactUrl,
          savePath: path.join(layout.librariesDir, relative),
          // 老的合并文件把加载器库的摘要留在条目顶层
          sha1: art.sha1 || lib.sha1 || '',
          size: art.size ?? lib.size ?? 0,
        })
      }
    }

    // Asset index + objects
    if (detail.assetIndex) {
      const assetDir = layout.assetsDir
      // 文件名与启动侧一致：优先用 assetIndex.id，其次 assets 字段
      const indexId = detail.assetIndex.id || detail.assets || gameVersion
      const indexPath = path.join(assetDir, 'indexes', `${indexId}.json`)
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
      if (lf.url) {
        taskSpecs.push({
          label: `logging config (${lf.id})`,
          url: lf.url,
          savePath: path.join(layout.logConfigsDir, lf.id),
          sha1: lf.sha1 ?? '',
          size: lf.size ?? 0,
        })
      }
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
    /**
     * 准备阶段的进度：文本进下载页的步骤说明，百分比进同一个进度条。
     * 百分比是「当前步骤」的进度（和 PCL 的分步百分比一致），换步骤时重新计。
     */
    const report = (note: string, percent?: number): void => {
      job.note = note
      if (percent === undefined || Number.isNaN(percent)) return
      job.preparePercent = Math.max(0, Math.min(100, Math.round(percent)))
    }
    let createdInstance = false
    log.info('开始准备安装「%s」（版本 %s，job %s）', job.instanceName, request.gameVersion, job.id)

    try {
      // 1. 安装状态：先落 installing 再写实例文件。启动页据此把它显示为
      //    「下载中」，完成（ready）之后才提供启动入口。
      createdInstance = true
      await writeInstallState(instanceDir, installRecordOf(job, 'installing'))
      if (isCancelled()) return

      report('获取版本信息')
      const parent = await fetchVersionDetail(request.gameVersion, abort.signal)
      if (isCancelled()) return

      const loader = request.loader
      let versionId = request.gameVersion
      let versionDetail: MojangVersionDetail = parent
      let onlyMissing = false

      if (loader) {
        const kind = safeLoaderKind(loader.kind)
        if (!kind) throw new Error(`不支持的加载器：${String(loader.kind)}`)
        const loaderVersion = safeVersionId(loader.version)
        if (!loaderVersion) throw new Error('无效的加载器版本')

        // 安装器类加载器在准备阶段就把文件放进实例；profile 类只需要版本档案
        const plan = await prepareLoaderInstall(
          kind,
          {
            gameVersion: request.gameVersion,
            loaderVersion,
            instanceDir,
            librariesDir: sharedLibrariesDir(dataDir),
            parent,
          },
          createLoaderEnvironment(kind, abort.signal, report),
        )
        if (isCancelled()) return

        versionId = safeVersionId(plan.versionId) ?? ''
        if (!versionId) throw new Error('加载器返回了无效的版本 id')
        versionDetail = mergeVersion(parent, plan.version)
        onlyMissing = plan.mode === 'installer'
        // 安装器可能改写过版本 jar，不能再按原版 sha1 校验
        if (onlyMissing) versionDetail = stripClientChecksum(versionDetail)
        // 版本文件与版本目录同名，启动时按 id 找 jar / 版本文件
        versionDetail = { ...versionDetail, id: versionId }
        job.loader = { kind, version: loaderVersion }
        log.info(
          '加载器 %s %s 已就绪：实例版本 %s',
          LOADER_LABELS[kind],
          loaderVersion,
          versionId,
        )
      }

      job.versionId = versionId
      // 实例目录本身就是版本目录：版本档案与客户端 jar 直接放在实例根
      const layout = resolveInstanceLayout(dataDir, instanceDir)

      // 2. version.json：加载器版本已与父版本合并成自包含文件，
      //    启动与补全只需要读这一个文件。
      ensureDir(layout.instanceDir)
      await writeFile(
        instanceVersionJson(instanceDir, versionId),
        JSON.stringify(versionDetail, null, 2),
        'utf8',
      )
      if (isCancelled()) return

      report('生成下载清单')
      const taskSpecs = await collectTaskSpecs(
        versionDetail,
        layout,
        versionId,
        abort.signal,
        { onlyMissing },
      )
      if (isCancelled()) return

      // 一个文件都不缺（缓存命中、共享库已有、或刚预取过）时没有任务可跑，
      // 也就不会有「任务完成」事件来收尾，必须在这里直接标记完成。
      if (taskSpecs.length === 0) {
        job.note = undefined
        job.preparePercent = undefined
        await completeJob(job)
        return
      }

      // 任务先全部登记（缓存命中由下载循环判断），提交因此始终是常数级耗时
      const paused = pausedJobs.has(job.id)
      enqueueTasks(job, taskSpecs, paused)

      job.state = 'ready'
      job.note = undefined
      job.preparePercent = undefined
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
      job.note = undefined
      job.preparePercent = undefined
      job.error = toError(cause).message
      log.error('准备安装「%s」失败：%s', job.instanceName, job.error)
    } finally {
      prepAborts.delete(job.id)
      if (isCancelled()) {
        job.state = 'cancelled'
        job.note = undefined
        job.preparePercent = undefined
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

      job.note = '检查缺失文件'
      const layout = resolveInstanceLayout(dataDir, instanceDir)
      const taskSpecs = await collectTaskSpecs(
        detail,
        layout,
        job.gameVersion,
        abort.signal,
        { onlyMissing: true },
      )
      if (isCancelled()) return

      if (taskSpecs.length === 0) {
        if (isCancelled()) return
        job.note = undefined
        job.preparePercent = undefined
        await completeJob(job)
        return
      }

      const paused = pausedJobs.has(job.id)
      enqueueTasks(job, taskSpecs, paused)
      job.state = 'ready'
      job.note = undefined
      job.preparePercent = undefined
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
      job.note = undefined
      job.preparePercent = undefined
      job.error = toError(cause).message
      log.error('补全实例「%s」失败：%s', job.instanceName, job.error)
    } finally {
      prepAborts.delete(job.id)
      if (isCancelled()) {
        job.state = 'cancelled'
        job.note = undefined
        job.preparePercent = undefined
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

  /**
   * 原版版本列表。
   *
   * 与下载走同一套下载源：Mojang 不可达时会自动尝试镜像，元数据请求也有
   * 超时，页面不会停在「正在获取版本列表」。
   */
  ctx.ipc.handle('versions/list', async (): Promise<GameVersion[]> => {
    const manifest = await fetchMojangManifest()
    return manifest.versions.map((version) => ({
      id: version.id,
      type: mapVersionType(version.type),
      releaseTime: version.releaseTime,
      url: version.url,
    }))
  })

  ctx.ipc.handle('settings/get', () => ({
    concurrency: String(maxConcurrency()),
    cacheDir: ctx.storage.get<string>('cacheDir', ''),
    cacheLimit: ctx.storage.get<string>('cacheLimit', DEFAULT_DOWNLOAD_CACHE_LIMIT),
    sources: loadSources(),
    loaderSources: loadLoaderSources(),
  }))

  ctx.ipc.handle<{ key: string; value: string }>('settings/set', ({ key, value }) => {
    if (key === 'sources' || key === 'loaderSources') {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { parsed = null }
      const normalized = key === 'sources'
        ? normalizeDownloadSources(parsed)
        : normalizeLoaderSources(parsed)
      ctx.storage.set(key, JSON.stringify(normalized))
      sourceHealth.clear()
      loaderVersionCache.clear()
      log.info('%s设置已更新', key === 'sources' ? '下载源' : '模组加载器下载源')
      return
    }
    ctx.storage.set(key, value)
    log.info('下载设置已更新：%s', key)
  })

  /**
   * 查询某个游戏版本的加载器版本列表。
   *
   * 版本来源随下载设置里的加载器源变化；查询失败时把原因原样抛回渲染进程，
   * 页面不需要知道具体是哪个镜像挂了。
   */
  ctx.ipc.handle<{ gameVersion?: string; kind?: string }>('loaders/versions', async (params) => {
    const kind = safeLoaderKind(params?.kind)
    if (!kind) throw new Error('不支持的加载器类型')
    const gameVersion = safeVersionId(params?.gameVersion)
    if (!gameVersion) throw new Error('无效的游戏版本')

    const cacheKey = `${kind}:${gameVersion}`
    const cached = loaderVersionCache.get(cacheKey)
    if (cached && Date.now() - cached.at < LOADER_VERSION_TTL) return cached.versions

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), METADATA_TIMEOUT)
    try {
      const versions = await listLoaderVersions(
        kind,
        gameVersion,
        createLoaderEnvironment(kind, abort.signal),
      )
      // 空结果（该游戏版本确实没有加载器）也缓存，避免反复打慢接口
      loaderVersionCache.set(cacheKey, { at: Date.now(), versions })
      return versions
    } finally {
      clearTimeout(timeout)
      // 慢源（例如 Forge 官方 promotions）不再需要：结果已返回或已失败
      abort.abort()
    }
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

  // 下载页首屏只需要聚合结果；逐文件任务可能有几万条，全部传输会拖慢开页
  ctx.ipc.handle('install/summary', (): InstallJobSummary[] =>
    [...jobs.values()].map(toSummary),
  )

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
    // 取消的任务只会出现在历史行里，汇总后即可丢掉逐文件明细
    archiveJob(job)
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
    if (!existsSync(versionJsonOf(job.instanceName, installedVersionId(job)))) {
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
    archiveSupersededJobs(instanceName, job.id)
    persistRecords()
    log.info('已受理补全实例「%s」：版本 %s，job %s', instanceName, versionId, job.id)

    void prepareRepair(job).catch(() => undefined)
    return { jobId: job.id }
  })

  ctx.ipc.handle<{ name: string }>('install/validate-name', ({ name }) => checkInstanceName(name))

  ctx.ipc.handle<InstallRequest>('install/start', (request) => {
    const gameVersion = safeVersionId(request?.gameVersion)
    if (!gameVersion) return { jobId: '', error: '无效的游戏版本' }

    const check = checkInstanceName(request.instanceName)
    if (!check.ok) return { jobId: '', error: check.message ?? '实例名称无效' }

    let loader: { kind: LoaderSourceKind; version: string } | undefined
    if (request.loader !== undefined && request.loader !== null) {
      const kind = safeLoaderKind(request.loader.kind)
      if (!kind) return { jobId: '', error: '不支持的加载器类型' }
      const loaderVersion = safeVersionId(request.loader.version)
      if (!loaderVersion) return { jobId: '', error: '无效的加载器版本' }
      loader = { kind, version: loaderVersion }
    }

    const instanceName = check.name
    const job: InstallJob = {
      id: nextJobId(),
      instanceName,
      gameVersion,
      loader,
      taskIds: [],
      createdAt: Date.now(),
      state: 'preparing',
      mode: 'install',
    }
    jobs.set(job.id, job)
    archiveSupersededJobs(instanceName, job.id)

    // 从受理到版本目录落盘之间占住名称，避免同一名称的并发安装互相覆盖
    reservedInstanceNames.add(instanceKey(instanceName))
    // 不做同步落盘：任务列表可能有上千条，写入会拖慢「点击即返回」的受理路径
    persistRecords()
    log.info(
      '已受理安装「%s」：版本 %s%s，job %s',
      instanceName,
      gameVersion,
      loader ? ` + ${LOADER_LABELS[loader.kind]} ${loader.version}` : '',
      job.id,
    )

    // 立刻返回：下载清单在后台准备，调用方直接跳转到下载页
    void prepareJob(job, { ...request, gameVersion, loader }).catch(() => undefined)

    return { jobId: job.id }
  })
}

export default defineMainPlugin({ name, inject, apply })