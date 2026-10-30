import type {
  ModLoader,
  ModSearchRequest,
  ModSource,
  ModSummary,
  ModVersion,
  ModVersionRequest,
} from '@mics/sdk'
import { isModLoader } from '@mics/sdk'
import { categoryLabelOf, MOD_LOADER_CATEGORY_KEYS, modrinthCategoryOf } from './categories'
import { endpoint, requestJson, withParams } from './http'

/**
 * Modrinth API v2。
 *
 * 搜索走 `/search`（服务端 facets 过滤游戏版本、加载器、类型），文件列表走
 * `/project/{id}/version`。项目 id 与文件 id 都由 Modrinth 生成，跨来源合并时
 * 再统一加上 `modrinth:` 前缀。
 */

interface ModrinthSearchHit {
  project_id?: string
  project_type?: string
  slug?: string
  author?: string
  organization?: string | null
  title?: string
  description?: string
  categories?: string[]
  display_categories?: string[]
  downloads?: number
  follows?: number
  icon_url?: string | null
  date_modified?: string
  versions?: string[]
}

interface ModrinthSearchResponse {
  hits?: ModrinthSearchHit[]
  total_hits?: number
}

interface ModrinthFile {
  url?: string
  filename?: string
  primary?: boolean
  size?: number
  hashes?: { sha1?: string; sha512?: string }
}

interface ModrinthVersion {
  id?: string
  project_id?: string
  name?: string
  version_number?: string
  version_type?: string
  game_versions?: string[]
  loaders?: string[]
  date_published?: string
  downloads?: number
  files?: ModrinthFile[]
}

interface ModrinthProject {
  id?: string
  slug?: string
  title?: string
  description?: string
  categories?: string[]
  downloads?: number
  follows?: number
  icon_url?: string | null
  date_modified?: string
}

export interface ModrinthIdentified {
  projectId: string
  versionId: string
  project: ModSummary
}

/** 一次最多取多少条；Modrinth 的 limit 上限是 100 */
const MAX_LIMIT = 100

function hitSummary(source: ModSource, hit: ModrinthSearchHit): ModSummary | null {
  const projectId = typeof hit.project_id === 'string' ? hit.project_id : ''
  if (!projectId) return null
  const slug = hit.slug || projectId
  const categories = [...new Set(
    (hit.display_categories ?? hit.categories ?? [])
      .filter((category) => !MOD_LOADER_CATEGORY_KEYS.has(category))
      .map(categoryLabelOf),
  )]

  return {
    id: `modrinth:${projectId}`,
    source: 'modrinth',
    sourceLabel: source.label.trim() || 'Modrinth',
    sourceApi: source.api,
    projectId,
    slug,
    name: hit.title?.trim() || slug,
    summary: hit.description?.trim() || '',
    author: hit.author?.trim() || hit.organization?.trim() || '',
    icon: hit.icon_url ?? '',
    downloads: hit.downloads ?? 0,
    follows: hit.follows ?? 0,
    categories,
    updated: hit.date_modified ?? '',
    url: `https://modrinth.com/mod/${encodeURIComponent(slug)}`,
  }
}

export async function searchModrinth(
  source: ModSource,
  request: ModSearchRequest,
  signal: AbortSignal,
  limit: number,
): Promise<{ items: ModSummary[]; total: number }> {
  const facets: string[][] = [['project_type:mod']]
  if (request.gameVersion) facets.push([`versions:${request.gameVersion}`])
  if (request.loader !== 'all') facets.push([`categories:${request.loader}`])
  if (request.category) {
    const category = modrinthCategoryOf(request.category)
    if (!category) return { items: [], total: 0 }
    facets.push([`categories:${category}`])
  }

  const items: ModSummary[] = []
  let total = 0
  let offset = 0
  let remaining = Math.max(1, limit)

  // Modrinth 单次最多 100 条；跨来源分页需要更多时继续取下一页
  while (remaining > 0) {
    const pageSize = Math.min(MAX_LIMIT, remaining)
    const url = withParams(endpoint(source.api, 'search'), {
      query: request.query,
      limit: String(pageSize),
      offset: String(offset),
      index: 'downloads',
      facets: JSON.stringify(facets),
    })

    const response = await requestJson<ModrinthSearchResponse>(url, { signal })
    const data = response.hits ?? []
    if (typeof response.total_hits === 'number') total = response.total_hits
    for (const hit of data) {
      const summary = hitSummary(source, hit)
      if (summary) items.push(summary)
    }
    if (data.length < pageSize) break
    offset += pageSize
    remaining -= pageSize
  }

  return { items, total: total || items.length }
}

function releaseChannel(value: string | undefined): ModVersion['channel'] {
  if (value === 'beta' || value === 'alpha') return value
  return 'release'
}

function versionOf(
  source: ModSource,
  projectId: string,
  version: ModrinthVersion,
): ModVersion | null {
  const files = version.files ?? []
  const file =
    files.find((candidate) => candidate.primary && candidate.url)
    ?? files.find((candidate) => candidate.url && candidate.filename?.toLowerCase().endsWith('.jar'))
    ?? files.find((candidate) => candidate.url)
  if (!file?.url || !file.filename) return null

  const loaders = (version.loaders ?? []).filter(isModLoader) as ModLoader[]
  return {
    id: `modrinth:${version.id ?? file.filename}`,
    source: 'modrinth',
    projectId,
    name: version.name?.trim() || version.version_number?.trim() || file.filename,
    versionNumber: version.version_number?.trim() || version.name?.trim() || '',
    channel: releaseChannel(version.version_type),
    gameVersions: [...new Set(version.game_versions ?? [])],
    loaders: [...new Set(loaders)],
    published: version.date_published ?? '',
    fileName: file.filename,
    fileUrl: file.url,
    sha1: file.hashes?.sha1 ?? '',
    size: file.size ?? 0,
    downloads: version.downloads ?? 0,
  }
}

function projectSummary(source: ModSource, project: ModrinthProject): ModSummary | null {
  const projectId = typeof project.id === 'string' ? project.id : ''
  if (!projectId) return null
  const slug = project.slug || projectId
  const categories = [...new Set(
    (project.categories ?? [])
      .filter((category) => !MOD_LOADER_CATEGORY_KEYS.has(category))
      .map(categoryLabelOf),
  )]

  return {
    id: `modrinth:${projectId}`,
    source: 'modrinth',
    sourceLabel: source.label.trim() || 'Modrinth',
    sourceApi: source.api,
    projectId,
    slug,
    name: project.title?.trim() || slug,
    summary: project.description?.trim() || '',
    author: '',
    icon: project.icon_url ?? '',
    downloads: project.downloads ?? 0,
    follows: project.follows ?? 0,
    categories,
    updated: project.date_modified ?? '',
    url: `https://modrinth.com/mod/${encodeURIComponent(slug)}`,
  }
}

/**
 * 通过 SHA1 精确识别本地文件所属的项目。
 *
 * 一次性把整批 SHA1 交给 version_files，再批量取 projects，避免每个文件
 * 单独打一次接口。
 */
export async function identifyModrinth(
  source: ModSource,
  files: Array<{ key: string; sha1?: string }>,
  signal: AbortSignal,
): Promise<Map<string, ModrinthIdentified>> {
  const hashes = [...new Set(files.map((file) => file.sha1).filter((sha1): sha1 is string => Boolean(sha1)))]
  const result = new Map<string, ModrinthIdentified>()
  if (hashes.length === 0) return result

  const versions = await requestJson<Record<string, ModrinthVersion>>(
    endpoint(source.api, 'version_files'),
    {
      method: 'POST',
      body: JSON.stringify({ hashes, algorithm: 'sha1' }),
      signal,
    },
  )

  const projectIds = [...new Set(
    Object.values(versions)
      .map((version) => version.project_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )]
  if (projectIds.length === 0) return result

  const projects = await requestJson<ModrinthProject[]>(
    withParams(endpoint(source.api, 'projects'), { ids: JSON.stringify(projectIds) }),
    { signal },
  )
  const projectById = new Map(
    projects
      .filter((project): project is ModrinthProject & { id: string } => typeof project.id === 'string')
      .map((project) => [project.id, projectSummary(source, project)]),
  )

  for (const file of files) {
    if (!file.sha1) continue
    const version = versions[file.sha1]
    if (!version?.project_id || !version.id) continue
    const project = projectById.get(version.project_id)
    if (!project) continue
    result.set(file.key, {
      projectId: version.project_id,
      versionId: version.id,
      project,
    })
  }
  return result
}

export async function versionsModrinth(
  source: ModSource,
  request: ModVersionRequest,
  signal: AbortSignal,
): Promise<ModVersion[]> {
  const params: Record<string, string> = {}
  if (request.gameVersion) params.game_versions = JSON.stringify([request.gameVersion])
  if (request.loader !== 'all') params.loaders = JSON.stringify([request.loader])

  const url = withParams(
    endpoint(source.api, `project/${encodeURIComponent(request.projectId)}/version`),
    params,
  )
  const response = await requestJson<ModrinthVersion[]>(url, { signal })
  const versions = (Array.isArray(response) ? response : [])
    .map((version) => versionOf(source, request.projectId, version))
    .filter((version): version is ModVersion => version !== null)

  versions.sort((a, b) => b.published.localeCompare(a.published))
  return versions
}
