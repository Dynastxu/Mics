import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  INVALID_INSTANCE_NAME_TEST,
  INSTANCE_STATE_FILE,
  isLoaderSourceKind,
  serialEvent,
  waterfallEvent
} from '@mics/sdk'
import type {
  CatalogFileRef,
  CatalogResolvedFile,
  DownloadEndpoint,
  DownloadFileRequest,
  DownloadJobHandle,
  GamePrepareResult,
  ModpackInstallRequest,
  VersionDetail
} from '@mics/sdk'
import { defineMainPlugin, instancesRoot } from '@mics/sdk/main'
import { extractModpackOverrides, parseModpackArchive, type ParsedModpack } from './archive'

export const name = 'mics.download.modpack'
export const inject = ['ipc', 'host']

/**
 * 整合包安装。
 *
 * 顺序：下载归档 → 解析清单 → 准备游戏版本（含加载器）→ 生成文件清单 →
 * 解析包内 CurseForge 文件 → 解压覆盖文件 → 全部下载 → 合并覆盖文件 →
 * 写 ready 标记。归档解析与覆盖合并属于本插件，下载与加载器分别走事件。
 */

const MODPACK_OVERRIDES_DIR = '.mics-modpack-overrides'
const RESERVED_INSTANCE_ROOT_FILES = new Set(['instance.json', INSTANCE_STATE_FILE])

interface ModpackJobState {
  jobId: string
  instanceName: string
  archivePath: string
  versionId?: string
  overridesDir?: string
  phase: 'preparing' | 'downloading' | 'finalizing'
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** 覆盖文件没有来源摘要，入库前现算一份 */
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function safeVersionId(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') return null
  if (path.basename(value) !== value) return null
  return INVALID_INSTANCE_NAME_TEST.test(value) ? null : value
}

/**
 * 把覆盖文件暂存目录合并进实例。
 *
 * 只复制文件、不整目录替换：实例里已经有下载好的 Mod / 配置时，覆盖文件
 * 只应补上或替换同名项，不能把其它文件一起删掉。
 *
 * 落盘交给调用方：实例里的 Mod 可能是内容库的硬链接，直接 `copyFile` 会写穿
 * 到共享实体，必须由调用方先写临时文件再改名。
 */
async function mergeOverrides(
  source: string,
  target: string,
  reservedRoot: Set<string>,
  place: (from: string, to: string) => Promise<void>,
  depth = 0
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (depth === 0 && reservedRoot.has(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await mergeOverrides(from, to, reservedRoot, place, depth + 1)
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true })
      await place(from, to)
    }
  }
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.modpack')
  const dataDir = ctx.host.paths.userData
  const jobs = new Map<string, ModpackJobState>()

  function instanceDirOf(name: string): string {
    return path.join(instancesRoot(dataDir), name)
  }

  /**
   * 覆盖文件落到实例。
   *
   * 先写临时文件再改名：目标是内容库的硬链接时，直接 `copyFile` 会写穿到
   * 共享实体，把别的实例正在用的同一个文件一起改掉。
   */
  async function placeOverride(from: string, to: string): Promise<void> {
    const temporary = `${to}.mics-override`
    await copyFile(from, temporary)
    await rename(temporary, to)
    await storeOverride(to)
  }

  /**
   * 覆盖文件里的 Mod 交给内容库接管（`download/commit`）。
   *
   * 覆盖文件来自归档、没有下载地址，摘要现算；内容库只是优化，失败时保留
   * 普通文件并继续安装，只有文件确实丢了才让安装失败。
   */
  async function storeOverride(file: string): Promise<void> {
    if (!/\.jar$/i.test(file) || path.basename(path.dirname(file)) !== 'mods') return
    try {
      const info = await stat(file)
      const placement = await waterfallEvent(
        ctx,
        'download/commit',
        {
          label: path.basename(file),
          url: '',
          savePath: file,
          sha1: await hashFile(file),
          size: info.size
        },
        async () => ({ path: file })
      )
      if (placement.path !== file && !existsSync(placement.path)) {
        throw new Error(`覆盖文件合并后不存在：${placement.path}`)
      }
    } catch (cause) {
      if (!existsSync(file)) throw toError(cause)
      log.warn('覆盖文件写入内容库失败（保留普通文件）：%s', toError(cause).message)
    }
  }

  /** 更新下载页进度条下方的阶段说明 */
  function reportStage(jobId: string, note: string): void {
    ctx.emit('download/report', jobId, { note })
  }

  async function finishJob(jobId: string, state: 'done' | 'failed', error?: string): Promise<void> {
    await serialEvent(ctx, 'download/finish', { jobId, state, ...(error ? { error } : {}) })
  }

  async function cleanup(job: ModpackJobState, removeInstance: boolean): Promise<void> {
    await rm(job.archivePath, { force: true }).catch(() => undefined)
    if (job.overridesDir) {
      await rm(job.overridesDir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (removeInstance) {
      await rm(instanceDirOf(job.instanceName), { recursive: true, force: true }).catch(
        () => undefined
      )
    }
  }

  function packFileSpecs(
    pack: ParsedModpack,
    instanceDir: string,
    versionId: string
  ): DownloadFileRequest[] {
    const reservedRoot = new Set([
      ...RESERVED_INSTANCE_ROOT_FILES,
      `${versionId}.json`,
      MODPACK_OVERRIDES_DIR
    ])
    const specs: DownloadFileRequest[] = []
    for (const file of pack.files) {
      if (file.kind !== 'direct') continue
      if (reservedRoot.has(file.path.split('/')[0] ?? '')) {
        throw new Error(`整合包包含不允许的文件路径：${file.path}`)
      }
      const endpoint: DownloadEndpoint = {
        id: `direct:${file.url}`,
        label: '直链',
        url: file.url
      }
      specs.push({
        label: path.basename(file.path) || file.path,
        url: file.url,
        savePath: path.join(instanceDir, file.path),
        sha1: file.sha1,
        size: file.size,
        sources: [endpoint]
      })
    }
    return specs
  }

  async function resolveCurseforgeFiles(
    pack: ParsedModpack,
    instanceDir: string,
    sourceApi?: string
  ): Promise<DownloadFileRequest[]> {
    const refs: CatalogFileRef[] = pack.files
      .filter((file) => file.kind === 'curseforge')
      .map((file) => ({
        projectId: file.projectId,
        fileId: file.fileId,
        required: file.required
      }))
    if (refs.length === 0) return []

    const resolved = await serialEvent(ctx, 'catalog/resolveModpackFiles', {
      refs,
      ...(sourceApi ? { sourceApi } : {})
    })
    if (!resolved) throw new Error('社区目录插件未启用，无法解析 CurseForge 文件')
    return (resolved as CatalogResolvedFile[]).map(({ file }) => ({
      label: file.fileName,
      url: file.url,
      savePath: path.join(instanceDir, 'mods', file.fileName),
      sha1: file.sha1 ?? '',
      size: file.size ?? 0,
      sources: [{ id: `direct:${file.url}`, label: '直链', url: file.url }]
    }))
  }

  async function finalizeJob(job: ModpackJobState): Promise<void> {
    if (!job.versionId) throw new Error('缺少版本 id，无法完成整合包安装')
    const instanceDir = instanceDirOf(job.instanceName)
    if (job.overridesDir && existsSync(job.overridesDir)) {
      reportStage(job.jobId, '合并覆盖文件')
      const instanceReserved = new Set([...RESERVED_INSTANCE_ROOT_FILES, `${job.versionId}.json`])
      await mergeOverrides(job.overridesDir, instanceDir, instanceReserved, placeOverride)
      await rm(job.overridesDir, { recursive: true, force: true }).catch(() => undefined)
      job.overridesDir = undefined
    }

    reportStage(job.jobId, '写入安装状态')
    const complete = await serialEvent(ctx, 'game/completeInstall', {
      jobId: job.jobId,
      instanceName: job.instanceName,
      versionId: job.versionId
    })
    void complete
    await finishJob(job.jobId, 'done')
    await cleanup(job, false)
    jobs.delete(job.jobId)
    log.info('整合包安装「%s」已完成：版本 %s', job.instanceName, job.versionId)
  }

  async function runInstall(
    job: ModpackJobState,
    request: ModpackInstallRequest,
    checkName: string,
    signal: AbortSignal
  ): Promise<void> {
    const instanceDir = instanceDirOf(checkName)
    try {
      await serialEvent(ctx, 'game/beginInstall', { jobId: job.jobId, instanceName: checkName })
      reportStage(job.jobId, '下载整合包')

      const endpoint: DownloadEndpoint = {
        id: `direct:${request.file.url}`,
        label: '直链',
        url: request.file.url
      }
      const archiveFiles = await serialEvent(ctx, 'download/addFiles', {
        jobId: job.jobId,
        files: [
          {
            label: request.file.fileName,
            url: request.file.url,
            savePath: job.archivePath,
            sha1: request.file.sha1 ?? '',
            size: request.file.size ?? 0,
            sources: [endpoint]
          }
        ]
      })
      if (!archiveFiles) throw new Error('下载管线未启用')
      const archiveResults = await serialEvent(ctx, 'download/awaitFiles', {
        jobId: job.jobId,
        taskIds: archiveFiles.taskIds
      })
      if (archiveResults?.[0]?.state !== 'done') {
        throw new Error(archiveResults?.[0]?.error ?? '整合包归档下载失败')
      }

      reportStage(job.jobId, '读取整合包清单')
      const pack = await parseModpackArchive(job.archivePath)
      if (pack.unsupportedLoader) {
        throw new Error(`暂不支持 ${pack.unsupportedLoader} 加载器，无法安装该整合包`)
      }
      if (!safeVersionId(pack.gameVersion)) throw new Error('整合包没有声明有效的游戏版本')

      let loader: { kind: 'fabric' | 'forge' | 'neoforge'; version: string } | undefined
      if (pack.loader) {
        if (!isLoaderSourceKind(pack.loader.kind)) {
          throw new Error(`暂不支持 ${pack.loader.kind} 加载器，无法安装该整合包`)
        }
        loader = { kind: pack.loader.kind, version: pack.loader.version }
      }

      job.phase = 'preparing'
      reportStage(job.jobId, '准备游戏版本')
      const prepared = await serialEvent(ctx, 'game/prepareVersion', {
        jobId: job.jobId,
        gameVersion: pack.gameVersion,
        ...(loader ? { loader } : {}),
        instanceDir,
        signal
      })
      if (!prepared) throw new Error('原版游戏插件未启用，无法准备整合包版本')
      const gamePrepared = prepared as GamePrepareResult
      job.versionId = gamePrepared.versionId
      job.phase = 'downloading'
      await serialEvent(ctx, 'download/data', {
        jobId: job.jobId,
        data: {
          owner: 'modpack',
          instanceName: checkName,
          archivePath: job.archivePath,
          versionId: job.versionId,
          phase: job.phase
        }
      })

      reportStage(job.jobId, '生成下载清单')
      const gameFiles = await serialEvent(ctx, 'game/collectFiles', {
        version: gamePrepared.version as VersionDetail,
        versionId: gamePrepared.versionId,
        instanceDir,
        onlyMissing: gamePrepared.mode === 'installer',
        ...(gamePrepared.sourcesFor ? { sourcesFor: gamePrepared.sourcesFor } : {}),
        signal
      })
      if (!gameFiles) throw new Error('原版游戏插件未启用，无法生成下载清单')

      const packFiles = packFileSpecs(pack, instanceDir, gamePrepared.versionId)
      if (pack.files.some((file) => file.kind === 'curseforge')) {
        reportStage(job.jobId, '解析包内文件')
      }
      const curseforgeFiles = await resolveCurseforgeFiles(pack, instanceDir, request.sourceApi)

      let overridesDir: string | undefined
      if (pack.overridePrefixes.length > 0) {
        reportStage(job.jobId, '解压整合包覆盖文件')
        const staging = path.join(instanceDir, MODPACK_OVERRIDES_DIR)
        const count = await extractModpackOverrides(job.archivePath, pack.overridePrefixes, staging)
        if (count > 0) overridesDir = staging
        else await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
      job.overridesDir = overridesDir
      await serialEvent(ctx, 'download/data', {
        jobId: job.jobId,
        data: {
          owner: 'modpack',
          instanceName: checkName,
          archivePath: job.archivePath,
          versionId: job.versionId,
          overridesDir,
          phase: job.phase
        }
      })

      const files = [...(gameFiles as DownloadFileRequest[]), ...packFiles, ...curseforgeFiles]
      if (files.length === 0) {
        await finalizeJob(job)
        return
      }
      reportStage(job.jobId, '下载整合包文件')
      await serialEvent(ctx, 'download/addFiles', { jobId: job.jobId, files })
      await serialEvent(ctx, 'download/seal', job.jobId)
      log.info(
        '整合包「%s」的下载清单已就绪：%d 个文件（其中包内文件 %d 个），job %s',
        checkName,
        files.length,
        packFiles.length + curseforgeFiles.length,
        job.jobId
      )
    } catch (cause) {
      jobs.delete(job.jobId)
      const error = toError(cause)
      await finishJob(job.jobId, 'failed', error.message)
      await cleanup(job, true)
      await serialEvent(ctx, 'game/discardInstall', {
        jobId: job.jobId,
        instanceName: checkName
      }).catch(() => undefined)
      log.error('准备整合包安装「%s」失败：%s', checkName, error.message)
    }
  }

  ctx.ipc.handle<ModpackInstallRequest>('modpacks/install', async (request) => {
    const file = request?.file
    if (!file) return { jobId: '', error: '缺少整合包文件信息' }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(typeof file.url === 'string' ? file.url.trim() : '')
    } catch {
      return { jobId: '', error: '无效的整合包下载地址' }
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return { jobId: '', error: '整合包下载地址必须使用 HTTP(S)' }
    }

    const rawName = typeof file.fileName === 'string' ? file.fileName : ''
    const fileName = path.basename(rawName)
    if (
      !fileName ||
      fileName !== rawName ||
      !/\.(mrpack|zip)$/i.test(fileName) ||
      INVALID_INSTANCE_NAME_TEST.test(fileName)
    ) {
      return { jobId: '', error: '无效的整合包文件名' }
    }
    if (request.source !== 'modrinth' && request.source !== 'curseforge') {
      return { jobId: '', error: '不支持的整合包下载源' }
    }
    if (typeof request.instanceName !== 'string') {
      return { jobId: '', error: '无效的实例名称' }
    }

    const check = await serialEvent(ctx, 'game/validateName', { name: request.instanceName })
    if (!check) return { jobId: '', error: '原版游戏插件未启用' }
    if (!check.ok) return { jobId: '', error: check.message ?? '实例名称无效' }

    const rawSha1 = typeof file.sha1 === 'string' ? file.sha1.trim().toLowerCase() : ''
    const sha1 = /^[0-9a-f]{40}$/.test(rawSha1) ? rawSha1 : ''
    const size =
      typeof file.size === 'number' && Number.isFinite(file.size) ? Math.max(0, file.size) : 0
    const title =
      typeof request.title === 'string' && request.title.trim()
        ? request.title.trim().slice(0, 120)
        : fileName

    const archivePath = path.join(
      dataDir,
      'cache',
      'downloads',
      'modpacks',
      `work-${Date.now()}-${fileName}`
    )
    await mkdir(path.dirname(archivePath), { recursive: true })

    const handle = await serialEvent(ctx, 'download/create', {
      title,
      detail: `实例：${check.name}`,
      kind: 'modpack',
      scope: { instanceName: check.name },
      display: { mode: 'install' },
      data: {
        owner: 'modpack',
        instanceName: check.name,
        archivePath
      }
    })
    if (!handle) return { jobId: '', error: '下载管线未启用' }

    const job: ModpackJobState = {
      jobId: (handle as DownloadJobHandle).jobId,
      instanceName: check.name,
      archivePath,
      phase: 'preparing'
    }
    jobs.set(job.jobId, job)
    log.info(
      '已受理整合包安装「%s」：%s → 实例「%s」，job %s',
      title,
      fileName,
      check.name,
      job.jobId
    )

    const normalized: ModpackInstallRequest = {
      ...request,
      instanceName: check.name,
      file: { url: parsedUrl.toString(), fileName, ...(sha1 ? { sha1 } : {}), size },
      ...(request.sourceApi ? { sourceApi: request.sourceApi } : {})
    }
    void runInstall(job, normalized, check.name, new AbortController().signal)
    return { jobId: job.jobId }
  })

  ctx.on('download/filesDone', async (jobId: string) => {
    const job = jobs.get(jobId)
    if (!job) return
    job.phase = 'finalizing'
    try {
      await finalizeJob(job)
    } catch (cause) {
      // 保留 job：文件已经下完，重试只需重做覆盖合并与 ready 标记
      await finishJob(jobId, 'failed', toError(cause).message)
      log.error('完成整合包安装「%s」失败：%s', job.instanceName, toError(cause).message)
    }
  })

  ctx.on('download/jobFinished', async (jobId: string, result) => {
    if (result.state !== 'cancelled') return
    const job = jobs.get(jobId)
    if (!job) return
    jobs.delete(jobId)
    await cleanup(job, true)
    await serialEvent(ctx, 'game/discardInstall', {
      jobId,
      instanceName: job.instanceName
    }).catch(() => undefined)
    log.info('整合包安装「%s」已取消，半成品已清理', job.instanceName)
  })

  ctx.on('download/discarded', async (jobId: string) => {
    const job = jobs.get(jobId)
    jobs.delete(jobId)
    if (job) await cleanup(job, false)
  })

  ctx.on('download/retry', async (jobId: string): Promise<boolean> => {
    const job = jobs.get(jobId)
    if (!job || job.phase !== 'finalizing') return false
    try {
      await finalizeJob(job)
    } catch (cause) {
      await finishJob(jobId, 'failed', toError(cause).message)
    }
    return true
  })

  ctx.on('download/jobResumed', async (jobId: string, snapshot) => {
    const data = snapshot.data as
      | {
          owner?: string
          instanceName?: string
          archivePath?: string
          versionId?: string
          overridesDir?: string
        }
      | undefined
    if (data?.owner !== 'modpack' || !data.instanceName || !data.archivePath) return
    if (!data.versionId && snapshot.state !== 'finalizing') {
      await finishJob(jobId, 'failed', '应用退出时仍在准备整合包，请删除后重新安装')
      return
    }
    const job: ModpackJobState = {
      jobId,
      instanceName: data.instanceName,
      archivePath: data.archivePath,
      ...(data.versionId ? { versionId: data.versionId } : {}),
      ...(data.overridesDir ? { overridesDir: data.overridesDir } : {}),
      phase: snapshot.state === 'finalizing' ? 'finalizing' : 'downloading'
    }
    jobs.set(jobId, job)
    if (job.phase === 'finalizing' || (snapshot.taskIds.length === 0 && job.versionId)) {
      try {
        await finalizeJob(job)
      } catch (cause) {
        await finishJob(jobId, 'failed', toError(cause).message)
      }
      return
    }
    await serialEvent(ctx, 'download/seal', jobId)
  })
}

export default defineMainPlugin({ name, inject, apply })
