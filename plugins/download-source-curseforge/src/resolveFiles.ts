import { INVALID_INSTANCE_NAME_TEST } from '@mics/sdk'
import type {
  CatalogBlockedFile,
  CatalogFileRef,
  CatalogResolvedFile,
  CatalogResolvedModpack,
  ModSource
} from '@mics/sdk'
import { curseforgeHeaders } from './api'
import { directDownloadUrl } from './downloadUrl'
import { endpoint, requestJson } from './http'

/**
 * 把 CurseForge 整合包清单里的 projectID / fileID 解析成可安装文件。
 *
 * 清单本身只有数字 id；文件地址、文件名与 SHA1 都要再查 CurseForge API。
 * 优先使用批量接口，缺失的条目再逐个补查，避免个别条目导致整包失败。
 *
 * 作者关闭第三方分发时 API 会返回 `downloadUrl: null`。这类文件不是错误：
 * 它们进 `blocked` 清单，由整合包安装流程引导用户手动下载、校验后再继续。
 */

interface CurseforgeHash {
  value?: string
  algo?: number
}

interface CurseforgeFile {
  id?: number
  modId?: number
  fileName?: string
  fileLength?: number
  downloadUrl?: string | null
  hashes?: CurseforgeHash[]
}

interface CurseforgeFilesResponse {
  data?: CurseforgeFile[]
}

interface CurseforgeMod {
  id?: number
  name?: string
  slug?: string
  classId?: number
}

interface CurseforgeModsResponse {
  data?: CurseforgeMod[]
}

const BATCH_SIZE = 50
const FALLBACK_CONCURRENCY = 6

/** 项目 classId -> 项目页路径；未知类型按 Mod 处理 */
const CLASS_PATHS: Record<number, string> = {
  6: 'mc-mods',
  12: 'texture-packs',
  4471: 'modpacks',
  6552: 'shaders',
  6945: 'data-packs'
}

function sha1Of(file: CurseforgeFile): string {
  return (
    (file.hashes ?? [])
      .find((hash) => hash.algo === 1 && typeof hash.value === 'string')
      ?.value?.toLowerCase() ?? ''
  )
}

/** 文件名会直接拼进实例目录，来源数据也必须按单层文件名处理 */
function fileNameOf(file: CurseforgeFile): string {
  const fileName = typeof file.fileName === 'string' ? file.fileName.trim() : ''
  if (!fileName) return ''
  if (fileName !== fileName.split(/[\\/]/).pop()) return ''
  if (INVALID_INSTANCE_NAME_TEST.test(fileName)) return ''
  return fileName
}



function sizeOf(file: CurseforgeFile): number {
  return typeof file.fileLength === 'number' && file.fileLength > 0 ? file.fileLength : 0
}

function pageUrlOf(project: CurseforgeMod | undefined, fileId: number): string {
  const slug = project?.slug?.trim()
  if (!slug) return ''
  const dir = CLASS_PATHS[project?.classId ?? 6] ?? 'mc-mods'
  return `https://www.curseforge.com/minecraft/${dir}/${encodeURIComponent(slug)}/files/${fileId}`
}

async function resolveBatch(
  source: ModSource,
  fileIds: number[],
  signal: AbortSignal
): Promise<Map<number, CurseforgeFile>> {
  const result = new Map<number, CurseforgeFile>()
  const response = await requestJson<CurseforgeFilesResponse>(endpoint(source.api, 'mods/files'), {
    method: 'POST',
    body: JSON.stringify({ fileIds }),
    headers: curseforgeHeaders(source),
    signal
  })
  for (const file of response.data ?? []) {
    if (typeof file.id === 'number') result.set(file.id, file)
  }
  return result
}

async function resolveOne(
  source: ModSource,
  entry: CatalogFileRef,
  signal: AbortSignal
): Promise<CurseforgeFile | undefined> {
  const response = await requestJson<{ data?: CurseforgeFile }>(
    endpoint(source.api, `mods/${entry.projectId}/files/${entry.fileId}`),
    { headers: curseforgeHeaders(source), signal }
  )
  return response.data
}

/** 批量读取项目元数据（slug / 类型 / 展示名），只给待手动下载的文件拼页面地址 */
async function resolveProjects(
  source: ModSource,
  projectIds: number[],
  signal: AbortSignal
): Promise<Map<number, CurseforgeMod>> {
  const result = new Map<number, CurseforgeMod>()
  if (projectIds.length === 0) return result
  try {
    const response = await requestJson<CurseforgeModsResponse>(endpoint(source.api, 'mods'), {
      method: 'POST',
      body: JSON.stringify({ modIds: projectIds }),
      headers: curseforgeHeaders(source),
      signal
    })
    for (const mod of response.data ?? []) {
      if (typeof mod.id === 'number') result.set(mod.id, mod)
    }
  } catch (cause) {
    if (signal.aborted) throw cause
    // 元数据只影响手动下载入口的链接与名称，拿不到也不应该让安装直接失败
  }
  return result
}

/** 按清单顺序返回文件引用；缺文件 / 文件名无效时抛出可操作错误 */
export async function resolveCurseforgeModpackFiles(
  source: ModSource,
  entries: CatalogFileRef[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void
): Promise<CatalogResolvedModpack> {
  if (entries.length === 0) return { files: [], blocked: [] }

  const files = new Map<number, CurseforgeFile>()
  const uniqueIds = [...new Set(entries.map((entry) => entry.fileId))]
  for (let offset = 0; offset < uniqueIds.length; offset += BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + BATCH_SIZE)
    try {
      const resolved = await resolveBatch(source, batch, signal)
      for (const [id, file] of resolved) files.set(id, file)
    } catch (cause) {
      if (signal.aborted) throw cause
      // 批量接口失败不致命：下面逐条补查，错误会在真正缺文件时暴露
    }
    onProgress?.(Math.min(offset + batch.length, uniqueIds.length), uniqueIds.length)
  }

  const missing = entries.filter((entry) => !files.has(entry.fileId))
  for (let offset = 0; offset < missing.length; offset += FALLBACK_CONCURRENCY) {
    const batch = missing.slice(offset, offset + FALLBACK_CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (entry) => {
        const file = await resolveOne(source, entry, signal)
        return { entry, file }
      })
    )
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        if (signal.aborted) throw outcome.reason
        continue
      }
      const file = outcome.value.file
      if (file) files.set(outcome.value.entry.fileId, file)
    }
  }

  const resolved: CatalogResolvedFile[] = []
  const blockedEntries: Array<{
    entry: CatalogFileRef
    fileName: string
    sha1: string
    size: number
  }> = []

  for (const entry of entries) {
    const file = files.get(entry.fileId)
    if (!file) {
      if (!entry.required) continue
      throw new Error(`整合包引用的 CurseForge 文件不存在：${entry.projectId}/${entry.fileId}`)
    }
    const fileName = fileNameOf(file)
    if (!fileName) {
      if (!entry.required) continue
      throw new Error(`整合包引用的 CurseForge 文件名无效：${entry.projectId}/${entry.fileId}`)
    }

    const url = directDownloadUrl(file.downloadUrl)
    if (!url) {
      // 作者关闭了第三方分发：文件名、摘要与大小仍然可信，交给手动下载流程
      blockedEntries.push({
        entry,
        fileName,
        sha1: sha1Of(file),
        size: sizeOf(file)
      })
      continue
    }

    resolved.push({
      entry,
      file: {
        url,
        fileName,
        sha1: sha1Of(file),
        size: sizeOf(file)
      }
    })
  }

  const projects = await resolveProjects(
    source,
    [...new Set(blockedEntries.map(({ entry }) => entry.projectId))],
    signal
  )
  const blocked: CatalogBlockedFile[] = blockedEntries.map(({ entry, fileName, sha1, size }) => {
    const project = projects.get(entry.projectId)
    return {
      entry,
      fileName,
      sha1,
      size,
      pageUrl: pageUrlOf(project, entry.fileId),
      projectName: project?.name?.trim() || ''
    }
  })

  return { files: resolved, blocked }
}
