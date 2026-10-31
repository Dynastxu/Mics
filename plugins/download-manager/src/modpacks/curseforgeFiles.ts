import type { ModFileRef, ModSource } from '@mics/sdk'
import { curseforgeHeaders } from '../mods/curseforge'
import { endpoint, requestJson } from '../mods/http'
import type { ModpackCurseforgeFile } from './archive'

/**
 * 把 CurseForge 整合包清单里的 projectID / fileID 解析成可下载文件。
 *
 * 清单本身只有数字 id；文件地址、文件名与 SHA1 都要再查 CurseForge API。
 * 优先使用批量接口，缺失的条目再逐个补查，避免个别条目导致整包失败。
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

const BATCH_SIZE = 50
const FALLBACK_CONCURRENCY = 6

function sha1Of(file: CurseforgeFile): string {
  return (file.hashes ?? [])
    .find((hash) => hash.algo === 1 && typeof hash.value === 'string')
    ?.value?.toLowerCase() ?? ''
}

function fileRefOf(file: CurseforgeFile): ModFileRef | null {
  const fileName = typeof file.fileName === 'string' ? file.fileName.trim() : ''
  if (!fileName) return null
  // 文件名会直接拼进实例目录，来源数据也必须按单层文件名处理
  if (fileName !== fileName.split(/[\\/]/).pop()) return null
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(fileName)) return null

  const downloadUrl = typeof file.downloadUrl === 'string' ? file.downloadUrl.trim() : ''
  if (!/^https?:\/\//i.test(downloadUrl)) {
    throw new Error(`整合包文件「${fileName}」没有下载地址（作者可能关闭了第三方分发）`)
  }

  return {
    url: downloadUrl,
    fileName,
    sha1: sha1Of(file),
    size: typeof file.fileLength === 'number' && file.fileLength > 0 ? file.fileLength : 0,
  }
}

async function resolveBatch(
  source: ModSource,
  fileIds: number[],
  signal: AbortSignal,
): Promise<Map<number, CurseforgeFile>> {
  const result = new Map<number, CurseforgeFile>()
  const response = await requestJson<CurseforgeFilesResponse>(
    endpoint(source.api, 'mods/files'),
    {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
      headers: curseforgeHeaders(source),
      signal,
    },
  )
  for (const file of response.data ?? []) {
    if (typeof file.id === 'number') result.set(file.id, file)
  }
  return result
}

async function resolveOne(
  source: ModSource,
  entry: ModpackCurseforgeFile,
  signal: AbortSignal,
): Promise<CurseforgeFile | undefined> {
  const response = await requestJson<{ data?: CurseforgeFile }>(
    endpoint(source.api, `mods/${entry.projectId}/files/${entry.fileId}`),
    { headers: curseforgeHeaders(source), signal },
  )
  return response.data
}

/** 按清单顺序返回文件引用；缺文件 / 无下载地址时抛出可操作错误 */
export async function resolveCurseforgeModpackFiles(
  source: ModSource,
  entries: ModpackCurseforgeFile[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ entry: ModpackCurseforgeFile; file: ModFileRef }>> {
  if (entries.length === 0) return []

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
      }),
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

  const resolved: Array<{ entry: ModpackCurseforgeFile; file: ModFileRef }> = []
  for (const entry of entries) {
    const file = files.get(entry.fileId)
    if (!file) {
      if (!entry.required) continue
      throw new Error(`整合包引用的 CurseForge 文件不存在：${entry.projectId}/${entry.fileId}`)
    }
    let ref: ModFileRef | null
    try {
      ref = fileRefOf(file)
    } catch (cause) {
      if (!entry.required) continue
      throw cause
    }
    if (!ref) {
      if (!entry.required) continue
      throw new Error(`整合包引用的 CurseForge 文件名无效：${entry.projectId}/${entry.fileId}`)
    }
    resolved.push({ entry, file: ref })
  }
  return resolved
}
