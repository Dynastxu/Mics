import type {
  ModDependency,
  ModLoader,
  ModSearchRequest,
  ModSource,
  ModSummary,
  ModVersion,
  ModVersionRequest,
} from '@mics/sdk'
import { MOD_LOADER_LABELS, modSourceNeedsKey } from '@mics/sdk'
import { curseforgeCategoriesOf, curseforgeCategoryLabel } from './categories'
import { endpoint, requestJson, withParams } from './http'

/**
 * CurseForge 官方 API。
 *
 * 搜索与文件接口都需要 `x-api-key`；没有 Key 时由聚合层跳过该来源，页面会
 * 提示去设置里填写。游戏固定为 Minecraft（432），类别固定为 Mod（6）。
 */

const GAME_ID = 432
const CLASS_ID = 6
const API_KEY_HEADER = 'x-api-key'

/** CurseForge 的 modLoaderType 枚举 */
const LOADER_IDS: Record<ModLoader, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
}

const LOADER_NAMES = new Map<string, ModLoader>(
  Object.entries(MOD_LOADER_LABELS).map(([id, label]) => [label.toLowerCase(), id as ModLoader]),
)

const MAX_PAGE_SIZE = 50

interface CurseforgeAuthor {
  name?: string
}

interface CurseforgeCategory {
  name?: string
}

interface CurseforgeLogo {
  thumbnailUrl?: string
  url?: string
}

interface CurseforgeMod {
  id?: number
  name?: string
  slug?: string
  summary?: string
  downloadCount?: number
  authors?: CurseforgeAuthor[]
  categories?: CurseforgeCategory[]
  logo?: CurseforgeLogo | null
  dateModified?: string
  links?: { websiteUrl?: string }
}

interface CurseforgeSearchResponse {
  data?: CurseforgeMod[]
  pagination?: { totalCount?: number }
}

interface CurseforgeHash {
  value?: string
  algo?: number
}

interface CurseforgeDependency {
  /** 依赖的项目 id；0 表示 CurseForge 未收录该项目 */
  modId?: number
  /** 关系：1 内嵌 / 2 可选 / 3 必装 / 4 工具 / 5 冲突 */
  relationType?: number
}

interface CurseforgeFile {
  id?: number
  displayName?: string
  fileName?: string
  releaseType?: number
  fileDate?: string
  fileLength?: number
  downloadCount?: number
  gameVersions?: string[]
  downloadUrl?: string | null
  hashes?: CurseforgeHash[]
  dependencies?: CurseforgeDependency[]
}

interface CurseforgeFilesResponse {
  data?: CurseforgeFile[]
  pagination?: { totalCount?: number }
}

interface CurseforgeFingerprintMatch {
  /** CurseForge 返回的指纹值 */
  id?: number
  file?: CurseforgeFile & { modId?: number }
}

interface CurseforgeFingerprintResponse {
  data?: {
    exactMatches?: CurseforgeFingerprintMatch[]
  }
}

interface CurseforgeModsResponse {
  data?: CurseforgeMod[]
}

interface CurseforgeModResponse {
  data?: CurseforgeMod
}

export interface CurseforgeIdentified {
  projectId: string
  versionId: string
  project: ModSummary
}

export function curseforgeReady(source: ModSource): boolean {
  return source.enabled && (!modSourceNeedsKey(source) || Boolean(source.key.trim()))
}

function apiHeaders(source: ModSource): Record<string, string> {
  const key = source.key.trim()
  if (!key) {
    if (modSourceNeedsKey(source)) {
      throw new Error('CurseForge 需要 API Key，请在「下载设置 → Mod 下载源」中填写')
    }
    return {}
  }
  return { [API_KEY_HEADER]: key }
}

function modSummary(source: ModSource, mod: CurseforgeMod): ModSummary | null {
  const projectId = typeof mod.id === 'number' ? String(mod.id) : ''
  if (!projectId) return null
  const slug = mod.slug?.trim() || projectId
  const categories = [...new Set(
    (mod.categories ?? [])
      .map((category) => category.name?.trim() ?? '')
      .filter(Boolean)
      .map(curseforgeCategoryLabel),
  )]

  return {
    id: `curseforge:${projectId}`,
    source: 'curseforge',
    sourceLabel: source.label.trim() || 'CurseForge',
    sourceApi: source.api,
    projectId,
    slug,
    name: mod.name?.trim() || slug,
    summary: mod.summary?.trim() || '',
    author: mod.authors?.[0]?.name?.trim() || '',
    icon: mod.logo?.thumbnailUrl?.trim() || mod.logo?.url?.trim() || '',
    downloads: mod.downloadCount ?? 0,
    follows: 0,
    categories,
    updated: mod.dateModified ?? '',
    url: mod.links?.websiteUrl?.trim()
      || `https://www.curseforge.com/minecraft/mc-mods/${encodeURIComponent(slug)}`,
  }
}

export async function searchCurseforge(
  source: ModSource,
  request: ModSearchRequest,
  signal: AbortSignal,
  limit: number,
): Promise<{ items: ModSummary[]; total: number }> {
  const headers = apiHeaders(source)
  const categoryIds = request.category ? curseforgeCategoriesOf(request.category) : []
  if (request.category && categoryIds.length === 0) return { items: [], total: 0 }

  const baseParams: Record<string, string> = {
    gameId: String(GAME_ID),
    classId: String(CLASS_ID),
    searchFilter: request.query,
    gameVersion: request.gameVersion,
    sortField: '6',
    sortOrder: 'desc',
  }
  if (request.loader !== 'all') {
    baseParams.modLoaderType = String(LOADER_IDS[request.loader])
  }
  if (categoryIds[0] !== undefined) {
    baseParams.categoryId = String(categoryIds[0])
  }

  const items: ModSummary[] = []
  let total = 0
  let offset = 0
  let remaining = Math.max(1, limit)

  // 单次最多 50 条；翻到第 3 页以后需要把前几页也取回来再全局排序
  while (remaining > 0) {
    const pageSize = Math.min(MAX_PAGE_SIZE, remaining)
    const url = withParams(endpoint(source.api, 'mods/search'), {
      ...baseParams,
      index: String(offset),
      pageSize: String(pageSize),
    })
    const response = await requestJson<CurseforgeSearchResponse>(url, { headers, signal })
    const data = response.data ?? []
    if (typeof response.pagination?.totalCount === 'number') {
      total = response.pagination.totalCount
    }
    for (const mod of data) {
      const summary = modSummary(source, mod)
      if (summary) items.push(summary)
    }
    if (data.length < pageSize) break
    offset += pageSize
    remaining -= pageSize
  }

  return { items, total: total || items.length }
}

/** 读取单个项目的完整摘要；前置跳转时用来补齐详情页头部 */
export async function projectCurseforge(
  source: ModSource,
  projectId: string,
  signal: AbortSignal,
): Promise<ModSummary> {
  const response = await requestJson<CurseforgeModResponse>(
    endpoint(source.api, `mods/${encodeURIComponent(projectId)}`),
    { headers: apiHeaders(source), signal },
  )
  const summary = response.data ? modSummary(source, response.data) : null
  if (!summary) throw new Error('CurseForge 没有返回有效的项目信息')
  return summary
}

function releaseChannel(releaseType: number | undefined): ModVersion['channel'] {
  if (releaseType === 2) return 'beta'
  if (releaseType === 3) return 'alpha'
  return 'release'
}

function loaderOf(value: string): ModLoader | null {
  return LOADER_NAMES.get(value.trim().toLowerCase()) ?? null
}

/** 未登记的依赖关系直接丢弃，避免把来源扩展字段带进契约 */
function dependencyKind(relationType: number | undefined): ModDependency['kind'] | null {
  switch (relationType) {
    case 1:
      return 'embedded'
    case 2:
      return 'optional'
    case 3:
      return 'required'
    case 5:
      return 'incompatible'
    default:
      return null
  }
}

function dependenciesOf(
  file: CurseforgeFile,
  projects: Map<number, ModSummary>,
): ModDependency[] {
  const dependencies: ModDependency[] = []
  for (const dependency of file.dependencies ?? []) {
    const kind = dependencyKind(dependency.relationType)
    // modId 为 0 表示该前置没有收录进 CurseForge，无法给出名称与链接
    if (!kind || typeof dependency.modId !== 'number' || dependency.modId <= 0) continue
    const project = projects.get(dependency.modId)
    dependencies.push({
      projectId: String(dependency.modId),
      name: project?.name || `Mod #${dependency.modId}`,
      versionId: '',
      kind,
      ...(project ? { project } : {}),
    })
  }
  return dependencies
}

/**
 * 批量解析依赖项目。
 *
 * 顺便把项目摘要带回去，点击版本行里的前置按钮就不用再发一次请求。
 * 解析失败只影响名称，不应该让整个版本列表报错，因此网络失败时退回空表。
 */
async function dependencyProjects(
  source: ModSource,
  files: CurseforgeFile[],
  signal: AbortSignal,
): Promise<Map<number, ModSummary>> {
  const ids = new Set<number>()
  for (const file of files) {
    for (const dependency of file.dependencies ?? []) {
      if (typeof dependency.modId === 'number' && dependency.modId > 0) {
        ids.add(dependency.modId)
      }
    }
  }
  if (ids.size === 0) return new Map()

  try {
    const response = await requestJson<CurseforgeModsResponse>(
      endpoint(source.api, 'mods'),
      {
        method: 'POST',
        body: JSON.stringify({ modIds: [...ids] }),
        headers: apiHeaders(source),
        signal,
      },
    )
    const summaries = new Map<number, ModSummary>()
    for (const mod of response.data ?? []) {
      if (typeof mod.id !== 'number') continue
      const summary = modSummary(source, mod)
      if (summary) summaries.set(mod.id, summary)
    }
    return summaries
  } catch (cause) {
    if (signal.aborted) throw cause
    return new Map()
  }
}

function versionOf(
  source: ModSource,
  projectId: string,
  file: CurseforgeFile,
  projects: Map<number, ModSummary>,
): ModVersion | null {
  if (typeof file.id !== 'number' || !file.downloadUrl || !file.fileName) return null
  const downloadUrl = file.downloadUrl
  const fileName = file.fileName

  const loaders: ModLoader[] = []
  const gameVersions: string[] = []
  for (const value of file.gameVersions ?? []) {
    const loader = loaderOf(value)
    if (loader) loaders.push(loader)
    // CurseForge 把加载器、Client/Server 与游戏版本混在同一个数组里
    else if (/^\d/.test(value)) gameVersions.push(value)
  }

  const sha1 = (file.hashes ?? [])
    .find((hash) => hash.algo === 1 && typeof hash.value === 'string')
    ?.value?.toLowerCase() ?? ''

  return {
    id: `curseforge:${file.id}`,
    source: 'curseforge',
    projectId,
    name: file.displayName?.trim() || fileName,
    versionNumber: file.displayName?.trim() || '',
    channel: releaseChannel(file.releaseType),
    gameVersions: [...new Set(gameVersions)],
    loaders: [...new Set(loaders)],
    published: file.fileDate ?? '',
    fileName,
    fileUrl: downloadUrl,
    sha1,
    size: file.fileLength ?? 0,
    downloads: file.downloadCount ?? 0,
    dependencies: dependenciesOf(file, projects),
  }
}

/**
 * 通过 CurseForge 指纹精确识别本地文件。
 *
 * 指纹端点和 `mods` 批量接口都需要 API Key；没有 Key 时由聚合层跳过。
 */
export async function identifyCurseforge(
  source: ModSource,
  files: Array<{ key: string; murmur2?: number }>,
  signal: AbortSignal,
): Promise<Map<string, CurseforgeIdentified>> {
  const headers = apiHeaders(source)
  const fingerprints = [...new Set(
    files
      .map((file) => file.murmur2)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
  )]
  const result = new Map<string, CurseforgeIdentified>()
  if (fingerprints.length === 0) return result

  const response = await requestJson<CurseforgeFingerprintResponse>(
    endpoint(source.api, 'fingerprints/432'),
    {
      method: 'POST',
      body: JSON.stringify({ fingerprints }),
      headers,
      signal,
    },
  )
  const matches = response.data?.exactMatches ?? []
  if (matches.length === 0) return result

  const modIds = [...new Set(
    matches
      .map((match) => match.file?.modId)
      .filter((id): id is number => typeof id === 'number'),
  )]
  if (modIds.length === 0) return result

  const modsResponse = await requestJson<CurseforgeModsResponse>(
    endpoint(source.api, 'mods'),
    {
      method: 'POST',
      body: JSON.stringify({ modIds }),
      headers,
      signal,
    },
  )
  const mods = new Map<number, CurseforgeMod>()
  for (const mod of modsResponse.data ?? []) {
    if (typeof mod.id === 'number') mods.set(mod.id, mod)
  }

  // exactMatches 返回的是平台文件；用文件名把结果对回调用方的 key。
  const matchByFileName = new Map<string, CurseforgeFile & { modId?: number }>()
  for (const match of matches) {
    if (match.file?.fileName) matchByFileName.set(match.file.fileName, match.file)
  }

  for (const file of files) {
    if (typeof file.murmur2 !== 'number') continue
    const fileName = file.key.split(/[\\/]/).pop() ?? file.key
    const modFile = matchByFileName.get(fileName)
    if (!modFile || typeof modFile.id !== 'number' || typeof modFile.modId !== 'number') continue
    const mod = mods.get(modFile.modId)
    if (!mod) continue
    const project = modSummary(source, mod)
    if (!project) continue
    result.set(file.key, {
      projectId: String(mod.id),
      versionId: String(modFile.id),
      project,
    })
  }
  return result
}

export async function versionsCurseforge(
  source: ModSource,
  request: ModVersionRequest,
  signal: AbortSignal,
): Promise<ModVersion[]> {
  const headers = apiHeaders(source)
  const params: Record<string, string> = { gameVersion: request.gameVersion }
  if (request.loader !== 'all') {
    params.modLoaderType = String(LOADER_IDS[request.loader])
  }

  const files: CurseforgeFile[] = []
  let total = 0
  let offset = 0

  // 单个版本 + 单个加载器下通常不到 50 个文件，但老 Mod 可能更多；
  // 分页取完再排序，页面看到的是完整列表。
  while (files.length < 400) {
    const url = withParams(
      endpoint(source.api, `mods/${encodeURIComponent(request.projectId)}/files`),
      {
        ...params,
        index: String(offset),
        pageSize: String(MAX_PAGE_SIZE),
      },
    )
    const response = await requestJson<CurseforgeFilesResponse>(url, { headers, signal })
    const data = response.data ?? []
    if (typeof response.pagination?.totalCount === 'number') {
      total = response.pagination.totalCount
    }
    files.push(...data)
    if (data.length < MAX_PAGE_SIZE) break
    if (total > 0 && files.length >= total) break
    offset += data.length
  }

  const projects = await dependencyProjects(source, files, signal)
  const versions = files
    .map((file) => versionOf(source, request.projectId, file, projects))
    .filter((version): version is ModVersion => version !== null)

  versions.sort((a, b) => b.published.localeCompare(a.published))
  return versions
}
