import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
  normalizeDownloadSources,
  validateInstanceName,
} from '@mics/sdk'
import type {
  DownloadProgress,
  DownloadSource,
  DownloadTask,
  InstallJob,
  InstanceNameCheck,
  InstallRequest,
} from '@mics/sdk'

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

function httpGetJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { signal }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (err) { reject(err) }
      })
    })
    req.setTimeout(10_000, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

function remapUrl(url: string, src: DownloadSource): string {
  return url
    .replace('launchermeta.mojang.com', src.launchermeta)
    .replace('libraries.minecraft.net', src.libraries)
    .replace('resources.download.minecraft.net', src.resources)
}

export const name = 'mics.download.manager'
export const inject = ['ipc', 'storage']

export function apply(ctx: Context): void {
  const tasks = new Map<string, DownloadTask>()
  const jobs = new Map<string, InstallJob>()
  const activeFetches = new Map<string, AbortController>()
  const cancelledTasks = new Set<string>()
  const cancelledJobs = new Set<string>()

  const dataDir = app.getPath('userData')
  const cacheRoot = path.join(dataDir, 'cache', 'downloads')
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 })

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

  let cachedManifest: unknown = null
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
      jobs.set(job.id, job)
    }

    for (const value of raw.tasks) {
      const task = value as DownloadTask
      if (!task || typeof task.id !== 'string' || typeof task.installId !== 'string') continue
      if (!jobs.has(task.installId) || !task.progress || typeof task.progress !== 'object') continue

      if (task.state !== 'done' && task.state !== 'failed') {
        // 上次退出时还在队列/下载/校验中的任务，重启后从暂停状态继续。
        task.state = 'paused'
        task.progress.loaded = 0
        task.progress.speed = 0
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

  async function fetchMojangManifest(signal?: AbortSignal): Promise<{
    latest: { release: string; snapshot: string }
    versions: Array<{ id: string; type: string; releaseTime: string; url: string }>
  }> {
    if (cachedManifest && Date.now() - cachedAt < CACHE_TTL) {
      return cachedManifest as Awaited<ReturnType<typeof fetchMojangManifest>>
    }
    const sources = loadSources()
    const enabled = enabledSourceIndexes(sources)
    if (enabled.length === 0) throw new Error('未启用任何下载源')
    let lastError: Error | null = null
    for (const index of enabled) {
      const src = sources[index]!
      try {
        const manifestUrl = remapUrl('https://launchermeta.mojang.com/mc/game/version_manifest.json', src)
        const data = await httpGetJson(manifestUrl, signal)
        cachedManifest = data
        cachedAt = Date.now()
        return data as Awaited<ReturnType<typeof fetchMojangManifest>>
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    throw lastError ?? new Error('所有下载源均不可用')
  }

  async function fetchVersionDetail(version: string): Promise<MojangVersionDetail> {
    const manifest = await fetchMojangManifest()
    const entry = manifest.versions.find((v) => v.id === version)
    if (!entry) throw new Error(`未找到版本 ${version}`)

    const sources = loadSources()
    const enabled = enabledSourceIndexes(sources)
    if (enabled.length === 0) throw new Error('未启用任何下载源')
    let lastError: Error | null = null
    for (const index of enabled) {
      const src = sources[index]!
      try {
        const detailUrl = remapUrl(entry.url, src)
        const data = await httpGetJson(detailUrl)
        return data as MojangVersionDetail
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    throw lastError ?? new Error('所有下载源均不可用')
  }

  function scheduleLoop(): void {
    const active = [...tasks.values()].filter((t) => t.state === 'downloading').length
    const slots = maxConcurrency() - active
    if (slots <= 0) return
    const pending = [...tasks.values()].filter((t) => t.state === 'pending')
    for (const task of pending.slice(0, slots)) {
      startDownload(task)
    }
  }

  async function dropCancelled(task: DownloadTask, ...files: string[]): Promise<boolean> {
    if (!cancelledTasks.has(task.id)) return false
    activeFetches.delete(task.id)
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    for (const file of files) {
      await rm(file, { force: true }).catch(() => undefined)
    }
    return true
  }

  interface DownloadResponse {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    stream: NodeJS.ReadableStream
  }

  function requestStream(url: string, signal: AbortSignal, redirects = 0): Promise<DownloadResponse> {
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
          requestStream(next, signal, redirects + 1).then(resolve, reject)
          return
        }

        if (status >= 400) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }

        resolve({
          statusCode: status,
          headers: res.headers as Record<string, string | string[] | undefined>,
          stream: res,
        })
      })

      req.setTimeout(10_000, () => req.destroy(new Error('下载请求超时')))
      req.on('error', reject)
    })
  }

  async function startDownload(task: DownloadTask): Promise<void> {
    if (cancelledTasks.has(task.id)) return

    task.state = 'downloading'
    const sources = loadSources()
    const tmpPath = task.savePath + '.part'
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

    for (let ci = 0; ci < order.length; ci++) {
      const si = order[ci]
      if (si === undefined) continue
      const src = sources[si]
      if (!src) continue
      const url = remapUrl(task.url, src)
      const abort = new AbortController()
      activeFetches.set(task.id, abort)
      const targetDir = path.dirname(task.savePath)
      ensureDir(targetDir)

      try {
        const response = await requestStream(url, abort.signal)

        const totalHeader = response.headers['content-length']
        const total = totalHeader ? Number(totalHeader) : -1
        task.progress.total = total
        task.size = total > 0 ? total : task.size

        const writeStream = createWriteStream(tmpPath)
        const hashObj = task.sha1 ? createHash('sha1') : null

        let loaded = 0
        response.stream.on('data', (chunk: Buffer) => {
          loaded += chunk.length
          task.progress.loaded = loaded
          task.progress.speed = 0
          if (hashObj) hashObj.update(chunk)
        })

        await pipeline(response.stream, writeStream)

        if (await dropCancelled(task, tmpPath)) return

        task.progress.loaded = loaded
        task.progress.speed = 0

        if (task.sha1 && hashObj) {
          task.state = 'verifying'
          const actual = hashObj.digest('hex')
          if (actual !== task.sha1) {
            throw new Error(`SHA1 校验失败：期望 ${task.sha1}，实际 ${actual}`)
          }
        }

        if (await dropCancelled(task, tmpPath)) return

        await rename(tmpPath, task.savePath)

        if (await dropCancelled(task, task.savePath)) return

        if (task.sha1) {
          const cached = cachePath(task.sha1)
          if (!existsSync(cached)) {
            ensureDir(path.dirname(cached))
            await copyFile(task.savePath, cached)
          }
        }

        if (await dropCancelled(task, task.savePath)) return

        reportSource(si, category, true)
        task.state = 'done'
        activeFetches.delete(task.id)
        persistRecords()
        scheduleLoop()
        return
      } catch (cause: unknown) {
        if (await dropCancelled(task, tmpPath, task.savePath)) return

        if (cause instanceof Error && cause.name === 'AbortError') {
          if ((task.state as string) === 'paused') return
          task.state = 'pending'
          scheduleLoop()
          return
        }
        reportSource(si, category, false)
        if (ci < order.length - 1) {
          task.progress.loaded = 0
          task.progress.total = 0
          task.progress.speed = 0
          continue
        }
        task.state = 'failed'
        task.error = cause instanceof Error ? cause.message : String(cause)
        activeFetches.delete(task.id)
        persistRecords()
        scheduleLoop()
        return
      }
    }
  }

  function pauseTask(taskId: string): void {
    const task = tasks.get(taskId)
    if (!task || task.state !== 'downloading') return
    task.state = 'paused'
    activeFetches.get(taskId)?.abort()
  }

  function resumeTask(taskId: string): void {
    const task = tasks.get(taskId)
    if (!task || task.state !== 'paused') return
    task.state = 'pending'
    task.progress.loaded = 0
    task.progress.speed = 0
    scheduleLoop()
  }

  function cancelTask(taskId: string): void {
    const task = tasks.get(taskId)
    if (!task || task.state === 'done' || task.state === 'failed') return
    cancelledTasks.add(taskId)
    task.state = 'failed'
    task.error = '已取消'
    task.progress.speed = 0
    activeFetches.get(taskId)?.abort()
  }

  function nextTaskId(): string {
    taskSeq += 1
    return `task_${taskSeq}`
  }

  function nextJobId(): string {
    jobSeq += 1
    return `job_${jobSeq}`
  }

  async function tryCopyFromCache(spec: TaskSpec): Promise<boolean> {
    if (!spec.sha1) return false
    const cached = cachePath(spec.sha1)
    if (!existsSync(cached)) return false
    ensureDir(path.dirname(spec.savePath))
    await copyFile(cached, spec.savePath)
    return true
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

  ctx.ipc.handle<{ taskId: string }>('tasks/cancel', ({ taskId }) => {
    cancelTask(taskId)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/pause', ({ taskId }) => {
    pauseTask(taskId)
    persistRecords(true)
  })
  ctx.ipc.handle<{ taskId: string }>('tasks/resume', ({ taskId }) => {
    resumeTask(taskId)
    persistRecords(true)
  })

  ctx.ipc.handle('install/list', () => [...jobs.values()])

  ctx.ipc.handle<{ jobId: string }>('install/cancel', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    cancelledJobs.add(jobId)
    for (const taskId of job.taskIds) cancelTask(taskId)
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/pause', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    for (const taskId of job.taskIds) pauseTask(taskId)
    persistRecords(true)
  })

  ctx.ipc.handle<{ jobId: string }>('install/resume', ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) return
    for (const taskId of job.taskIds) resumeTask(taskId)
    persistRecords(true)
  })

  ctx.ipc.handle<{ name: string }>('install/validate-name', ({ name }) => checkInstanceName(name))

  ctx.ipc.handle<InstallRequest>('install/start', async (request) => {
    const check = checkInstanceName(request.instanceName)
    if (!check.ok) return { jobId: '', error: check.message ?? '实例名称无效' }

    const instanceName = check.name
    const jobId = nextJobId()
    const job: InstallJob = {
      id: jobId,
      instanceName,
      gameVersion: request.gameVersion,
      loader: request.loader,
      taskIds: [],
      createdAt: Date.now(),
    }
    jobs.set(jobId, job)

    // 从受理到版本目录落盘之间占住名称，避免同一名称的并发安装互相覆盖
    const nameKey = instanceKey(instanceName)
    reservedInstanceNames.add(nameKey)

    const isCancelled = () => cancelledJobs.has(jobId)

    try {
      const detail = await fetchVersionDetail(request.gameVersion)
      if (isCancelled()) return { jobId, error: '已取消' }

      const versionsDir = path.join(instanceDirOf(instanceName), 'versions', request.gameVersion)

      const taskSpecs: TaskSpec[] = []

      // 1. version.json
      {
        const jsonPath = path.join(versionsDir, `${request.gameVersion}.json`)
        ensureDir(versionsDir)
        await writeFile(jsonPath, JSON.stringify(detail, null, 2))
      }

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
        const rawIndex = await httpGetJson(detail.assetIndex.url) as AssetIndex
        if (isCancelled()) return { jobId, error: '已取消' }
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

      for (const spec of taskSpecs) {
        if (isCancelled()) return { jobId, error: '已取消' }
        const taskId = nextTaskId()
        const fromCache = await tryCopyFromCache(spec)
        if (isCancelled()) return { jobId, error: '已取消' }
        const task: DownloadTask = {
          id: taskId,
          installId: jobId,
          url: spec.url,
          savePath: spec.savePath,
          sha1: spec.sha1,
          size: spec.size,
          label: spec.label,
          state: fromCache ? 'done' : 'pending',
          progress: {
            loaded: fromCache ? spec.size : 0,
            total: spec.size > 0 ? spec.size : -1,
            speed: 0,
            label: spec.label,
          },
          createdAt: Date.now(),
        }
        tasks.set(taskId, task)
        job.taskIds.push(taskId)
        persistRecords()
      }

      if (isCancelled()) return { jobId, error: '已取消' }
      persistRecords(true)
      scheduleLoop()
      return { jobId }
    } catch (cause) {
      persistRecords(true)
      return { jobId, error: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      // 版本目录此时已落盘，后续重名判断交给目录检查
      reservedInstanceNames.delete(nameKey)
    }
  })
}

export default defineMainPlugin({ name, inject, apply })