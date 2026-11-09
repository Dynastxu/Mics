import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  DEFAULT_DOWNLOAD_SOURCES,
  INVALID_INSTANCE_NAME_TEST,
  INSTANCE_STATE_FILE,
  LOADER_LABELS,
  isLoaderSourceKind,
  normalizeDownloadSources,
  serialEvent,
  validateInstanceName
} from '@mics/sdk'
import type {
  DownloadEndpoint,
  DownloadFileRequest,
  DownloadSource,
  GameBeginInstall,
  GameCollectInput,
  GameCompleteInstall,
  GameDiscardInstall,
  GamePrepareInput,
  GamePrepareResult,
  GameVersion,
  InstallRepairRequest,
  InstallRequest,
  InstallStartResult,
  InstanceInstallRecord,
  InstanceNameCheck,
  LoaderSourceKind,
  LoaderVersion,
  VersionDetail,
  VersionLibrary
} from '@mics/sdk'
import {
  artifactPlatformMatches,
  defineMainPlugin,
  instanceClientJar,
  instanceVersionJson,
  isReadableJar,
  joinBase,
  mavenPath,
  mergeVersion,
  resolveInstanceLayout,
  rulesAllow,
  sharedLibrariesDir,
  stripClientChecksum,
  fetchFirst
} from '@mics/sdk/main'
import type { InstanceLayout } from '@mics/sdk/main'

export const name = 'mics.download.game'
export const inject = ['ipc', 'storage', 'host']

/**
 * 原版游戏安装。
 *
 * 负责 Mojang 版本清单 / 版本档案、实例目录与 `install-state.json`、新装与补全
 * 的编排；加载器安装通过 `loader/prepare` 事件交给对应插件，文件下载通过
 * `download/*` 事件交给下载管线。
 */

interface GameJobState {
  jobId: string
  instanceName: string
  gameVersion: string
  versionId?: string
  loader?: { kind: LoaderSourceKind; version: string }
  mode: 'install' | 'repair'
  phase: 'preparing' | 'downloading' | 'finalizing'
  /** 新装失败 / 取消时需要删除半成品实例 */
  discardOnCancel: boolean
}

interface MojangArtifact {
  url?: string
  sha1?: string
  size?: number
  path?: string
}

interface MojangVersionDetail extends VersionDetail {
  downloads?: { client?: MojangArtifact; server?: MojangArtifact }
  libraries?: VersionLibrary[]
}

interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
}

interface MojangManifestSummary {
  latest: { release: string; snapshot: string }
  versions: Array<{ id: string; type: string; releaseTime: string; url: string }>
}

const VERSION_TYPE_MAP: Record<string, GameVersion['type']> = {
  release: 'release',
  snapshot: 'snapshot',
  old_alpha: 'old_alpha',
  old_beta: 'old_beta'
}

const METADATA_TIMEOUT = 20_000
const CACHE_TTL = 5 * 60 * 1000

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function mapVersionType(value: string): GameVersion['type'] {
  return VERSION_TYPE_MAP[value] ?? 'snapshot'
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

function sourceCategory(url: string): DownloadEndpoint['category'] {
  if (url.includes('resources.download.minecraft.net')) return 'asset'
  if (url.includes('libraries.minecraft.net')) return 'library'
  if (url.includes('launchermeta.mojang.com')) return 'meta'
  return 'file'
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.game')
  const dataDir = ctx.host.paths.userData
  const appVersion = ctx.host.app.version

  const activeJobs = new Map<string, GameJobState>()
  const reservedInstanceNames = new Set<string>()
  let cachedManifest: MojangManifestSummary | null = null
  let cachedAt = 0

  // -------------------------------------------------------------------------
  // 路径与名称
  // -------------------------------------------------------------------------

  function instancesRootDir(): string {
    return path.join(dataDir, '.minecraft', 'versions')
  }

  function instanceDirOf(name: string): string {
    return path.join(instancesRootDir(), name)
  }

  function versionJsonOf(name: string, versionId: string): string {
    return instanceVersionJson(instanceDirOf(name), versionId)
  }

  function instanceKey(name: string): string {
    return process.platform === 'win32' ? name.toLowerCase() : name
  }

  /** 更新下载页进度条下方的阶段说明 */
  function reportStage(jobId: string, note: string, percent?: number): void {
    ctx.emit('download/report', jobId, { note, ...(percent !== undefined ? { percent } : {}) })
  }

  function checkInstanceName(raw: string): InstanceNameCheck {
    const base = validateInstanceName(raw)
    if (!base.ok) return base

    if (existsSync(instanceDirOf(base.name))) {
      return {
        ok: false,
        name: base.name,
        issue: 'duplicate',
        message: `实例「${base.name}」已存在，请换一个名称`
      }
    }
    if (reservedInstanceNames.has(instanceKey(base.name))) {
      return {
        ok: false,
        name: base.name,
        issue: 'duplicate',
        message: `实例「${base.name}」正在安装，请换一个名称`
      }
    }
    return base
  }

  function safeInstanceName(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const check = validateInstanceName(value)
    return check.ok && check.name === value ? value : null
  }

  function safeVersionId(value: unknown): string | null {
    if (typeof value !== 'string' || !value || value === '.' || value === '..') return null
    if (path.basename(value) !== value) return null
    return INVALID_INSTANCE_NAME_TEST.test(value) ? null : value
  }

  async function writeInstallState(
    instanceDir: string,
    record: InstanceInstallRecord
  ): Promise<void> {
    if (!existsSync(instanceDir)) return
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

  function installRecordOf(
    job: GameJobState,
    state: InstanceInstallRecord['state']
  ): InstanceInstallRecord {
    return {
      state,
      jobId: job.jobId,
      gameVersion: job.gameVersion,
      ...(state === 'ready' ? { completedAt: Date.now() } : {})
    }
  }

  // -------------------------------------------------------------------------
  // 原版源
  // -------------------------------------------------------------------------

  function loadSources(): DownloadSource[] {
    try {
      const raw = ctx.storage.get<string>('sources', '')
      if (raw) return normalizeDownloadSources(JSON.parse(raw))
    } catch {
      /* fall through */
    }
    return normalizeDownloadSources(DEFAULT_DOWNLOAD_SOURCES)
  }

  function vanillaCandidates(url: string): DownloadEndpoint[] {
    const category = sourceCategory(url)
    const endpoints: DownloadEndpoint[] = []
    const seen = new Set<string>()
    for (const [index, source] of loadSources().entries()) {
      if (source.enabled === false) continue
      const candidate = remapVanillaUrl(url, source)
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      endpoints.push({
        id: `vanilla:${index}`,
        label: source.label.trim() || `源 ${index + 1}`,
        url: candidate,
        category
      })
    }
    return endpoints.length > 0
      ? endpoints
      : [{ id: `direct:${url}`, label: '直链', url, category }]
  }

  async function fetchFirstText(url: string, signal?: AbortSignal): Promise<string> {
    return fetchFirst(
      vanillaCandidates(url).map((endpoint) => endpoint.url),
      { signal, appVersion, parse: (text) => text, emptyMessage: '未启用任何下载源' }
    )
  }

  async function fetchFirstJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const text = await fetchFirstText(url, signal)
    return JSON.parse(text) as T
  }

  async function fetchMojangManifest(signal?: AbortSignal): Promise<MojangManifestSummary> {
    if (cachedManifest && Date.now() - cachedAt < CACHE_TTL) return cachedManifest
    const data = await fetchFirstJson<MojangManifestSummary>(
      'https://launchermeta.mojang.com/mc/game/version_manifest.json',
      signal
    )
    cachedManifest = data
    cachedAt = Date.now()
    return data
  }

  async function fetchVersionDetail(
    version: string,
    signal?: AbortSignal
  ): Promise<MojangVersionDetail> {
    const manifest = await fetchMojangManifest(signal)
    const entry = manifest.versions.find((item) => item.id === version)
    if (!entry) throw new Error(`未找到版本 ${version}`)
    return fetchFirstJson<MojangVersionDetail>(entry.url, signal)
  }

  function asyncVersionList(): Promise<GameVersion[]> {
    return fetchMojangManifest().then((manifest) =>
      manifest.versions.map((version) => ({
        id: version.id,
        type: mapVersionType(version.type),
        releaseTime: version.releaseTime,
        url: version.url
      }))
    )
  }

  // -------------------------------------------------------------------------
  // 文件清单
  // -------------------------------------------------------------------------

  function hashFile(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash('sha1')
      const stream = createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk as Buffer))
      stream.on('error', () => resolve(null))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  async function fileMatchesSpec(spec: DownloadFileRequest): Promise<boolean> {
    try {
      const info = await stat(spec.savePath)
      if (!info.isFile()) return false
      if (spec.sha1) {
        if ((spec.size ?? 0) > 0 && info.size !== spec.size) return false
        return (await hashFile(spec.savePath)) === spec.sha1
      }
      if ((spec.size ?? 0) > 0) return info.size === spec.size
      if (spec.savePath.toLowerCase().endsWith('.jar')) return isReadableJar(spec.savePath)
      return info.size > 0
    } catch {
      return false
    }
  }

  async function onlyMissingSpecs(specs: DownloadFileRequest[]): Promise<DownloadFileRequest[]> {
    const present = new Array<boolean>(specs.length).fill(false)
    const workers = Math.min(32, specs.length)
    let cursor = 0
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (true) {
          const index = cursor
          cursor += 1
          const spec = specs[index]
          if (!spec) return
          present[index] = await fileMatchesSpec(spec)
        }
      })
    )
    return specs.filter((_, index) => !present[index])
  }

  /**
   * 读取资源索引：优先用已有副本；落盘必须是原文，启动前会按 sha1 校验。
   */
  async function loadAssetIndex(
    detail: MojangVersionDetail,
    indexPath: string,
    signal: AbortSignal
  ): Promise<AssetIndex> {
    const expectedSha1 = detail.assetIndex?.sha1
    if (expectedSha1 && existsSync(indexPath)) {
      try {
        if ((await hashFile(indexPath)) === expectedSha1) {
          return JSON.parse(await readFile(indexPath, 'utf8')) as AssetIndex
        }
      } catch {
        /* 索引损坏，重新下载 */
      }
    }

    if (!detail.assetIndex?.url) throw new Error('版本缺少资源索引地址')
    const text = await fetchFirstText(detail.assetIndex.url, signal)
    const raw = JSON.parse(text) as AssetIndex
    await writeFile(indexPath, text).catch(async (cause) => {
      throw new Error(`无法写入资源索引：${toError(cause).message}`, { cause })
    })
    return raw
  }

  /** 把版本详情展开成下载清单；补全模式只保留目标文件缺失的项 */
  async function collectTaskSpecs(
    detail: MojangVersionDetail,
    layout: InstanceLayout,
    gameVersion: string,
    signal: AbortSignal,
    options: {
      onlyMissing?: boolean
      sourcesFor?: (url: string) => DownloadEndpoint[]
    } = {}
  ): Promise<DownloadFileRequest[]> {
    const candidatesFor = (url: string): DownloadEndpoint[] => {
      const loaderSources = options.sourcesFor?.(url)
      return loaderSources && loaderSources.length > 0 ? loaderSources : vanillaCandidates(url)
    }
    const specs: DownloadFileRequest[] = []

    const clientArtifact = detail.downloads?.client
    if (clientArtifact?.url) {
      specs.push({
        label: `client.jar (${gameVersion})`,
        url: clientArtifact.url,
        savePath: instanceClientJar(layout.instanceDir, gameVersion),
        sha1: clientArtifact.sha1 ?? '',
        size: clientArtifact.size ?? 0,
        sources: vanillaCandidates(clientArtifact.url)
      })
    }

    for (const lib of detail.libraries ?? []) {
      if (!rulesAllow(lib.rules)) continue

      const artifacts: MojangArtifact[] = []
      if (lib.downloads?.artifact) artifacts.push(lib.downloads.artifact)
      if (!lib.downloads?.artifact && lib.url) {
        const relative = mavenPath(lib.name)
        artifacts.push({
          url: joinBase(lib.url, relative),
          path: relative,
          sha1: lib.sha1,
          size: lib.size
        })
      }
      if (lib.downloads?.classifiers) {
        for (const [classifier, artifact] of Object.entries(lib.downloads.classifiers)) {
          const classifierOs = classifier.replace('natives-', '')
          if (classifierOs === 'windows' || classifierOs.startsWith('natives-windows')) {
            artifacts.push(artifact)
          }
        }
      }

      for (const artifact of artifacts) {
        const artifactUrl = artifact.url ?? ''
        if (!artifactUrl) continue
        const parts = lib.name.split(':')
        const fileName =
          parts.length >= 3
            ? `${parts[1]}-${parts[2]}${artifactUrl.includes('natives') ? '-' + (artifactUrl.match(/natives-[^/]+/)?.[0] ?? '') : ''}.jar`
            : `${lib.name.replace(/:/g, '/')}.jar`
        const libDir =
          parts.length >= 3
            ? path.join(parts[0]!.replace(/\./g, '/'), parts[1]!, parts[2]!)
            : path.dirname(lib.name.replace(/:/g, '/'))
        const relative = artifact.path ?? path.join(libDir, fileName)
        if (!artifactPlatformMatches(relative)) continue

        specs.push({
          label: lib.name,
          url: artifactUrl,
          savePath: path.join(layout.librariesDir, relative),
          sha1: artifact.sha1 || lib.sha1 || '',
          size: artifact.size ?? lib.size ?? 0,
          sources: candidatesFor(artifactUrl)
        })
      }
    }

    if (detail.assetIndex) {
      const assetDir = layout.assetsDir
      const indexId = detail.assetIndex.id || detail.assets || gameVersion
      const indexPath = path.join(assetDir, 'indexes', `${indexId}.json`)
      const rawIndex = await loadAssetIndex(detail, indexPath, signal)

      for (const [, obj] of Object.entries(rawIndex.objects ?? {})) {
        const hash = obj.hash.slice(0, 2)
        const url = `https://resources.download.minecraft.net/${hash}/${obj.hash}`
        specs.push({
          label: `asset ${obj.hash.slice(0, 12)}…`,
          url,
          savePath: path.join(assetDir, 'objects', hash, obj.hash),
          sha1: obj.hash,
          size: obj.size,
          sources: vanillaCandidates(url)
        })
      }
    }

    if (detail.logging?.client?.file) {
      const file = detail.logging.client.file
      if (file.url) {
        specs.push({
          label: `logging config (${file.id})`,
          url: file.url,
          savePath: path.join(layout.logConfigsDir, file.id),
          sha1: file.sha1 ?? '',
          size: file.size ?? 0,
          sources: vanillaCandidates(file.url)
        })
      }
    }

    return options.onlyMissing ? onlyMissingSpecs(specs) : specs
  }

  // -------------------------------------------------------------------------
  // 安装编排
  // -------------------------------------------------------------------------

  async function prepareVersion(input: GamePrepareInput): Promise<GamePrepareResult> {
    const signal = input.signal ?? new AbortController().signal
    reportStage(input.jobId, '获取版本信息')
    const parent = await fetchVersionDetail(input.gameVersion, signal)

    let versionId = input.gameVersion
    let version: VersionDetail = parent
    let mode: 'profile' | 'installer' = 'profile'
    let loader: { kind: LoaderSourceKind; version: string } | undefined
    let sourcesFor: ((url: string) => DownloadEndpoint[]) | undefined

    if (input.loader) {
      if (!isLoaderSourceKind(input.loader.kind)) {
        throw new Error(`不支持的加载器：${String(input.loader.kind)}`)
      }
      const loaderVersion = safeVersionId(input.loader.version)
      if (!loaderVersion) throw new Error('无效的加载器版本')

      const result = await serialEvent(ctx, 'loader/prepare', {
        jobId: input.jobId,
        kind: input.loader.kind,
        gameVersion: input.gameVersion,
        loaderVersion,
        instanceDir: input.instanceDir,
        librariesDir: sharedLibrariesDir(dataDir),
        parent,
        // 安装器需要原版客户端 jar；它必须走原版镜像，而不是直连 Mojang
        ...(parent.downloads?.client?.url
          ? { clientSources: vanillaCandidates(parent.downloads.client.url) }
          : {}),
        signal
      })
      if (!result) throw new Error(`未安装 ${LOADER_LABELS[input.loader.kind]} 加载器插件`)
      if (signal.aborted) throw new Error('已取消')

      versionId = safeVersionId(result.versionId) ?? ''
      if (!versionId) throw new Error('加载器返回了无效的版本 id')
      version = mergeVersion(parent, result.version)
      mode = result.mode
      // 安装器可能改写过版本 jar，不能再按原版 sha1 校验
      if (mode === 'installer') version = stripClientChecksum(version)
      version = { ...version, id: versionId }
      loader = { kind: input.loader.kind, version: loaderVersion }
      sourcesFor = result.sourcesFor
      log.info(
        '加载器 %s %s 已就绪：实例版本 %s',
        LOADER_LABELS[input.loader.kind],
        loaderVersion,
        versionId
      )
    }

    reportStage(input.jobId, '写入版本档案')
    if (!existsSync(input.instanceDir)) {
      throw new Error('实例目录已被删除，安装未完成')
    }
    await writeFile(
      instanceVersionJson(input.instanceDir, versionId),
      JSON.stringify(version, null, 2),
      'utf8'
    )
    return {
      versionId,
      version,
      mode,
      ...(loader ? { loader } : {}),
      ...(sourcesFor ? { sourcesFor } : {})
    }
  }

  async function beginInstall(request: GameBeginInstall): Promise<void> {
    const instanceDir = instanceDirOf(request.instanceName)
    await mkdir(instanceDir, { recursive: true })
    reservedInstanceNames.add(instanceKey(request.instanceName))
    await writeInstallState(instanceDir, {
      state: 'installing',
      jobId: request.jobId
    })
  }

  async function completeInstall(request: GameCompleteInstall): Promise<void> {
    const instanceDir = instanceDirOf(request.instanceName)
    if (!existsSync(instanceDir)) throw new Error('实例文件已被删除，安装未完成')
    if (!existsSync(versionJsonOf(request.instanceName, request.versionId))) {
      throw new Error('实例版本文件已丢失，安装未完成')
    }
    await writeInstallState(instanceDir, {
      state: 'ready',
      jobId: request.jobId,
      gameVersion: request.versionId,
      completedAt: Date.now()
    })
    reservedInstanceNames.delete(instanceKey(request.instanceName))
  }

  async function discardInstall(request: GameDiscardInstall): Promise<void> {
    reservedInstanceNames.delete(instanceKey(request.instanceName))
    const instanceDir = instanceDirOf(request.instanceName)
    if (!existsSync(instanceDir)) return
    await rm(instanceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(
      (cause) => {
        log.warn('清理安装「%s」的残留文件失败：%s', request.instanceName, toError(cause).message)
      }
    )
  }

  async function finishJob(jobId: string, state: 'done' | 'failed', error?: string): Promise<void> {
    await serialEvent(ctx, 'download/finish', {
      jobId,
      state,
      ...(error ? { error } : {})
    })
  }

  async function addFiles(jobId: string, files: DownloadFileRequest[]): Promise<void> {
    const result = await serialEvent(ctx, 'download/addFiles', { jobId, files })
    if (!result) throw new Error('下载管线未启用')
  }

  async function finalizeGameJob(job: GameJobState): Promise<void> {
    if (!job.versionId) throw new Error('缺少版本 id，无法完成安装')
    reportStage(job.jobId, '写入安装状态')
    await completeInstall({
      jobId: job.jobId,
      instanceName: job.instanceName,
      versionId: job.versionId
    })
    await finishJob(job.jobId, 'done')
    activeJobs.delete(job.jobId)
    log.info('安装「%s」已完成：版本 %s', job.instanceName, job.versionId)
  }

  async function runGameInstall(job: GameJobState, signal: AbortSignal): Promise<void> {
    const instanceDir = instanceDirOf(job.instanceName)
    try {
      job.phase = 'preparing'
      await beginInstall({ jobId: job.jobId, instanceName: job.instanceName })
      const prepared = await prepareVersion({
        jobId: job.jobId,
        gameVersion: job.gameVersion,
        ...(job.loader ? { loader: job.loader } : {}),
        instanceDir,
        signal
      })
      job.versionId = prepared.versionId
      job.phase = 'downloading'
      await serialEvent(ctx, 'download/data', {
        jobId: job.jobId,
        data: {
          owner: 'game',
          instanceName: job.instanceName,
          gameVersion: job.gameVersion,
          versionId: prepared.versionId,
          loader: job.loader,
          mode: job.mode,
          discardOnCancel: job.discardOnCancel
        }
      })

      const layout = resolveInstanceLayout(dataDir, instanceDir)
      reportStage(job.jobId, '生成下载清单')
      const files = await collectTaskSpecs(prepared.version, layout, prepared.versionId, signal, {
        onlyMissing: prepared.mode === 'installer',
        ...(prepared.sourcesFor ? { sourcesFor: prepared.sourcesFor } : {})
      })
      if (files.length === 0) {
        await finalizeGameJob(job)
        return
      }
      reportStage(job.jobId, '下载原版资源文件')
      await addFiles(job.jobId, files)
      await serialEvent(ctx, 'download/seal', job.jobId)
    } catch (cause) {
      const error = toError(cause)
      activeJobs.delete(job.jobId)
      await finishJob(job.jobId, 'failed', error.message)
      if (!signal.aborted)
        await discardInstall({ jobId: job.jobId, instanceName: job.instanceName })
      log.error('准备安装「%s」失败：%s', job.instanceName, error.message)
    }
  }

  async function runRepair(job: GameJobState, versionId: string): Promise<void> {
    job.versionId = versionId
    const instanceDir = instanceDirOf(job.instanceName)
    try {
      await writeInstallState(instanceDir, installRecordOf(job, 'installing'))
      let detail = JSON.parse(
        await readFile(versionJsonOf(job.instanceName, versionId), 'utf8')
      ) as MojangVersionDetail
      if (!detail?.id || !detail.mainClass) throw new Error('实例版本文件不完整')

      // 加载器实例的版本档案是「父版本 + 加载器差异」合并出来的。旧版本的合并
      // 会按 name 去重，丢掉 LWJGL 的 natives classifiers；补全时重新合并一遍，
      // 把父版本里的 natives / classifiers 补回来，再走缺失文件检查。
      if (detail.inheritsFrom) {
        reportStage(job.jobId, '修复版本档案')
        const parent = await fetchVersionDetail(detail.inheritsFrom)
        const normalized = mergeVersion(parent, detail)
        detail = { ...normalized, id: versionId }
        await writeFile(
          versionJsonOf(job.instanceName, versionId),
          JSON.stringify(detail, null, 2),
          'utf8'
        )
      }

      const layout = resolveInstanceLayout(dataDir, instanceDir)
      reportStage(job.jobId, '检查缺失文件')
      const files = await collectTaskSpecs(
        detail,
        layout,
        versionId,
        new AbortController().signal,
        {
          onlyMissing: true
        }
      )
      if (files.length === 0) {
        await finalizeGameJob(job)
        return
      }
      reportStage(job.jobId, '下载缺失文件')
      await addFiles(job.jobId, files)
      await serialEvent(ctx, 'download/seal', job.jobId)
    } catch (cause) {
      activeJobs.delete(job.jobId)
      await finishJob(job.jobId, 'failed', toError(cause).message)
      log.error('补全实例「%s」失败：%s', job.instanceName, toError(cause).message)
    }
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  ctx.on('game/versions', async (): Promise<GameVersion[]> => asyncVersionList())

  ctx.on('game/validateName', async (request: { name: string }) => checkInstanceName(request.name))

  ctx.on('game/prepareVersion', async (request: GamePrepareInput) => prepareVersion(request))

  ctx.on('game/collectFiles', async (request: GameCollectInput) => {
    const layout = resolveInstanceLayout(dataDir, request.instanceDir)
    return collectTaskSpecs(
      request.version as MojangVersionDetail,
      layout,
      request.versionId,
      request.signal ?? new AbortController().signal,
      {
        onlyMissing: request.onlyMissing,
        ...(request.sourcesFor ? { sourcesFor: request.sourcesFor } : {})
      }
    )
  })

  ctx.on('game/beginInstall', async (request: GameBeginInstall) => beginInstall(request))
  ctx.on('game/completeInstall', async (request: GameCompleteInstall) => completeInstall(request))
  ctx.on('game/discardInstall', async (request: GameDiscardInstall) => discardInstall(request))

  ctx.on('game/install', async (request: InstallRequest): Promise<InstallStartResult> => {
    const gameVersion = safeVersionId(request?.gameVersion)
    if (!gameVersion) return { jobId: '', error: '无效的游戏版本' }
    const check = checkInstanceName(request.instanceName)
    if (!check.ok) return { jobId: '', error: check.message ?? '实例名称无效' }

    let loader: { kind: LoaderSourceKind; version: string } | undefined
    if (request.loader) {
      if (!isLoaderSourceKind(request.loader.kind)) {
        return { jobId: '', error: '不支持的加载器类型' }
      }
      const loaderVersion = safeVersionId(request.loader.version)
      if (!loaderVersion) return { jobId: '', error: '无效的加载器版本' }
      loader = { kind: request.loader.kind, version: loaderVersion }
    }

    // 先占住名称，避免同一名称的并发安装都通过校验
    reservedInstanceNames.add(instanceKey(check.name))

    const handle = await serialEvent(ctx, 'download/create', {
      title: check.name,
      detail: loader
        ? `${gameVersion} · ${LOADER_LABELS[loader.kind]} ${loader.version}`
        : gameVersion,
      kind: 'game',
      scope: { instanceName: check.name },
      display: {
        gameVersion,
        ...(loader ? { loader } : {}),
        mode: 'install'
      },
      data: {
        owner: 'game',
        instanceName: check.name,
        gameVersion,
        loader,
        mode: 'install',
        discardOnCancel: true
      }
    })
    if (!handle) {
      reservedInstanceNames.delete(instanceKey(check.name))
      return { jobId: '', error: '下载管线未启用' }
    }

    const job: GameJobState = {
      jobId: handle.jobId,
      instanceName: check.name,
      gameVersion,
      ...(loader ? { loader } : {}),
      mode: 'install',
      phase: 'preparing',
      discardOnCancel: true
    }
    activeJobs.set(job.jobId, job)
    log.info(
      '已受理安装「%s」：版本 %s%s，job %s',
      check.name,
      gameVersion,
      loader ? ` + ${LOADER_LABELS[loader.kind]} ${loader.version}` : '',
      job.jobId
    )
    void runGameInstall(job, new AbortController().signal)
    return { jobId: job.jobId }
  })

  ctx.on('game/repair', async (request: InstallRepairRequest): Promise<InstallStartResult> => {
    const instanceName = safeInstanceName(request?.instanceName)
    if (!instanceName) return { jobId: '', error: '无效的实例名称' }
    const versionId = safeVersionId(request?.versionId)
    if (!versionId) return { jobId: '', error: '无效的版本 id' }
    const instanceDir = instanceDirOf(instanceName)
    if (!existsSync(instanceDir)) return { jobId: '', error: '实例不存在' }
    if (!existsSync(versionJsonOf(instanceName, versionId))) {
      return { jobId: '', error: '实例版本文件不存在' }
    }

    const active = [...activeJobs.values()].find(
      (job) => job.instanceName === instanceName && job.mode === 'install'
    )
    if (active) return { jobId: active.jobId }

    const handle = await serialEvent(ctx, 'download/create', {
      title: instanceName,
      detail: '补全文件',
      kind: 'game',
      scope: { instanceName },
      display: { gameVersion: versionId, mode: 'repair' },
      data: {
        owner: 'game',
        instanceName,
        gameVersion: versionId,
        versionId,
        mode: 'repair',
        discardOnCancel: false
      }
    })
    if (!handle) return { jobId: '', error: '下载管线未启用' }

    const job: GameJobState = {
      jobId: handle.jobId,
      instanceName,
      gameVersion: versionId,
      versionId,
      mode: 'repair',
      phase: 'preparing',
      discardOnCancel: false
    }
    activeJobs.set(job.jobId, job)
    void runRepair(job, versionId)
    return { jobId: job.jobId }
  })

  // 文件全部完成：由 game 负责写 ready 标记
  ctx.on('download/filesDone', async (jobId: string) => {
    const job = activeJobs.get(jobId)
    if (!job) return
    job.phase = 'finalizing'
    try {
      await finalizeGameJob(job)
    } catch (cause) {
      // 保留 job：文件已经下完，用户重试时只需重做收尾
      await finishJob(jobId, 'failed', toError(cause).message)
      log.error('完成安装「%s」失败：%s', job.instanceName, toError(cause).message)
    }
  })

  // 取消：新装删除半成品实例；补全保留实例
  ctx.on('download/jobFinished', async (jobId: string, result) => {
    if (result.state !== 'cancelled') return
    const job = activeJobs.get(jobId)
    if (!job) return
    activeJobs.delete(jobId)
    if (job.discardOnCancel) {
      await discardInstall({ jobId, instanceName: job.instanceName })
      log.info('安装「%s」已取消，半成品已清理', job.instanceName)
    }
  })

  // 收尾阶段失败（例如写标记失败）可以重试收尾
  ctx.on('download/retry', async (jobId: string): Promise<boolean> => {
    const job = activeJobs.get(jobId)
    if (!job || job.phase !== 'finalizing') return false
    try {
      await finalizeGameJob(job)
      return true
    } catch (cause) {
      await finishJob(jobId, 'failed', toError(cause).message)
      return true
    }
  })

  ctx.on('download/discarded', (jobId: string) => {
    activeJobs.delete(jobId)
  })

  // 启动后恢复未完成任务：重新挂上收尾逻辑
  ctx.on('download/jobResumed', async (jobId: string, snapshot) => {
    const data = snapshot.data as
      | {
          owner?: string
          instanceName?: string
          gameVersion?: string
          versionId?: string
          loader?: { kind: string; version: string }
          mode?: 'install' | 'repair'
          discardOnCancel?: boolean
        }
      | undefined
    if (data?.owner !== 'game' || !data.instanceName || !data.gameVersion) return
    // 退出时还没生成版本档案：无法从断点恢复准备阶段，明确失败
    if (!data.versionId && snapshot.state !== 'finalizing') {
      await finishJob(jobId, 'failed', '应用退出时仍在准备安装，请删除后重新安装')
      return
    }
    const job: GameJobState = {
      jobId,
      instanceName: data.instanceName,
      gameVersion: data.gameVersion,
      ...(data.versionId ? { versionId: data.versionId } : {}),
      ...(data.loader && isLoaderSourceKind(data.loader.kind)
        ? { loader: { kind: data.loader.kind, version: data.loader.version } }
        : {}),
      mode: data.mode === 'repair' ? 'repair' : 'install',
      phase: snapshot.state === 'finalizing' ? 'finalizing' : 'downloading',
      discardOnCancel: Boolean(data.discardOnCancel)
    }
    activeJobs.set(jobId, job)
    if (job.phase === 'finalizing' || (snapshot.taskIds.length === 0 && job.versionId)) {
      try {
        await finalizeGameJob(job)
      } catch (cause) {
        await finishJob(jobId, 'failed', toError(cause).message)
      }
      return
    }
    // 文件清单在退出前已经提交完：重新封口，等剩余任务结束后继续收尾
    await serialEvent(ctx, 'download/seal', jobId)
  })

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  ctx.ipc.handle('versions/list', async (): Promise<GameVersion[]> => asyncVersionList())

  /** 页面只需要加载器版本列表；路由到 `mics.download.loaders` */
  ctx.ipc.handle<{ gameVersion?: string; kind?: string }>('loaders/versions', async (params) => {
    if (!isLoaderSourceKind(params?.kind)) throw new Error('不支持的加载器类型')
    const gameVersion = safeVersionId(params?.gameVersion)
    if (!gameVersion) throw new Error('无效的游戏版本')
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), METADATA_TIMEOUT)
    try {
      const versions = await serialEvent(ctx, 'loader/versions', {
        kind: params.kind,
        gameVersion,
        signal: abort.signal
      })
      return (versions ?? []) as LoaderVersion[]
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  })

  ctx.ipc.handle<{ name: string }>('install/validate-name', ({ name }) => checkInstanceName(name))

  ctx.ipc.handle<InstallRequest>('install/start', async (request) => {
    const result = await serialEvent(ctx, 'game/install', request)
    return result ?? { jobId: '', error: '原版安装插件未启用' }
  })

  ctx.ipc.handle<InstallRepairRequest>('install/repair', async (request) => {
    const result = await serialEvent(ctx, 'game/repair', request)
    return result ?? { jobId: '', error: '原版安装插件未启用' }
  })

  ctx.ipc.handle('sources/get', (): DownloadSource[] => loadSources())

  ctx.ipc.handle<{ sources: DownloadSource[] }>('sources/set', ({ sources }) => {
    const normalized = normalizeDownloadSources(sources)
    ctx.storage.set('sources', JSON.stringify(normalized))
    cachedManifest = null
    cachedAt = 0
    log.info('原版下载源已更新（%d 个）', normalized.length)
  })

  // 从旧下载插件导入一次原版源配置
  if (!ctx.storage.get<boolean>('legacyImported')) {
    void serialEvent(ctx, 'download/legacy-config')
      .then((legacy) => {
        if (Array.isArray(legacy?.sources) && legacy.sources.length > 0) {
          ctx.storage.set('sources', JSON.stringify(normalizeDownloadSources(legacy.sources)))
          log.info('已从旧下载插件导入原版下载源')
        }
        ctx.storage.set('legacyImported', true)
      })
      .catch(() => undefined)
  }
}

export default defineMainPlugin({ name, inject, apply })
