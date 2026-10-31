import type {
  ModDependency,
  ModLoader,
  ModProjectKind,
  ModSearchRequest,
  ModSource,
  ModSummary,
  ModVersion,
  ModVersionRequest,
} from '@mics/sdk'
import { isModLoader } from '@mics/sdk'
import { categoryLabelOf, MOD_LOADER_CATEGORY_KEYS, modrinthCategoryOf } from './categories'
import {
  modpackCategoryLabelOf,
  modpackModrinthCategoryOf,
} from '../modpacks/categories'
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

interface ModrinthDependency {
  version_id?: string | null
  project_id?: string | null
  file_name?: string | null
  dependency_type?: string
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
  dependencies?: ModrinthDependency[]
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
  /** 团队 id；项目接口本身不含作者，需要再查团队成员 */
  team?: string
}

interface ModrinthTeamMember {
  role?: string
  user?: { username?: string }
}

export interface ModrinthIdentified {
  projectId: string
  versionId: string
  project: ModSummary
}

/** 一次最多取多少条；Modrinth 的 limit 上限是 100 */
const MAX_LIMIT = 100

function hitSummary(
  source: ModSource,
  hit: ModrinthSearchHit,
  kind: ModProjectKind,
): ModSummary | null {
  const projectId = typeof hit.project_id === 'string' ? hit.project_id : ''
  if (!projectId) return null
  const slug = hit.slug || projectId
  const labelOf = kind === 'modpack' ? modpackCategoryLabelOf : categoryLabelOf
  const categories = [...new Set(
    (hit.display_categories ?? hit.categories ?? [])
      .filter((category) => !MOD_LOADER_CATEGORY_KEYS.has(category))
      .map(labelOf),
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
    url: `https://modrinth.com/${kind}/${encodeURIComponent(slug)}`,
  }
}

export async function searchModrinth(
  source: ModSource,
  request: ModSearchRequest,
  signal: AbortSignal,
  limit: number,
  kind: ModProjectKind = 'mod',
): Promise<{ items: ModSummary[]; total: number }> {
  const facets: string[][] = [[`project_type:${kind}`]]
  if (request.gameVersion) facets.push([`versions:${request.gameVersion}`])
  if (request.loader !== 'all') facets.push([`categories:${request.loader}`])
  if (request.category) {
    const category = kind === 'modpack'
      ? modpackModrinthCategoryOf(request.category)
      : modrinthCategoryOf(request.category)
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
      const summary = hitSummary(source, hit, kind)
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

/** 未登记的依赖类型直接丢弃，避免把来源扩展字段带进契约 */
function dependencyKind(value: string | undefined): ModDependency['kind'] | null {
  switch (value) {
    case 'required':
    case 'optional':
    case 'incompatible':
    case 'embedded':
      return value
    default:
      return null
  }
}

function dependenciesOf(
  version: ModrinthVersion,
  projects: Map<string, ModSummary>,
): ModDependency[] {
  const dependencies: ModDependency[] = []
  for (const dependency of version.dependencies ?? []) {
    const kind = dependencyKind(dependency.dependency_type)
    if (!kind) continue
    const projectId = dependency.project_id ?? ''
    const project = projectId ? projects.get(projectId) : undefined
    const name = project?.name || dependency.file_name?.trim() || projectId
    if (!name) continue
    dependencies.push({
      projectId,
      name,
      versionId: dependency.version_id ?? '',
      kind,
      ...(project ? { project } : {}),
    })
  }
  return dependencies
}

/**
 * 批量解析依赖项目。
 *
 * 依赖里只有 project_id，直接展示 id 没有意义；顺便把项目摘要带回去，
 * 点击版本行里的前置按钮就不用再发一次请求。解析失败只影响名称，
 * 不应该让整个版本列表报错，因此网络失败时退回空表。
 */
async function dependencyProjects(
  source: ModSource,
  versions: ModrinthVersion[],
  signal: AbortSignal,
): Promise<Map<string, ModSummary>> {
  const ids = new Set<string>()
  for (const version of versions) {
    for (const dependency of version.dependencies ?? []) {
      if (dependency.project_id) ids.add(dependency.project_id)
    }
  }
  if (ids.size === 0) return new Map()

  try {
    const projects = await requestJson<ModrinthProject[]>(
      withParams(endpoint(source.api, 'projects'), { ids: JSON.stringify([...ids]) }),
      { signal },
    )
    const summaries = new Map<string, ModSummary>()
    for (const project of projects) {
      if (!project.id) continue
      const summary = projectSummary(source, project)
      if (summary) summaries.set(project.id, summary)
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
  version: ModrinthVersion,
  projects: Map<string, ModSummary>,
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
    dependencies: dependenciesOf(version, projects),
  }
}

function projectSummary(
  source: ModSource,
  project: ModrinthProject,
  kind: ModProjectKind = 'mod',
): ModSummary | null {
  const projectId = typeof project.id === 'string' ? project.id : ''
  if (!projectId) return null
  const slug = project.slug || projectId
  const labelOf = kind === 'modpack' ? modpackCategoryLabelOf : categoryLabelOf
  const categories = [...new Set(
    (project.categories ?? [])
      .filter((category) => !MOD_LOADER_CATEGORY_KEYS.has(category))
      .map(labelOf),
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
    url: `https://modrinth.com/${kind}/${encodeURIComponent(slug)}`,
  }
}

/**
 * 项目作者。
 *
 * Modrinth 的项目接口没有作者字段；搜索接口展示的作者是团队 Owner，
 * 这里按同样规则取 Owner，取不到再退回第一个成员。
 */
async function projectAuthor(
  source: ModSource,
  teamId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!teamId) return ''
  try {
    const members = await requestJson<ModrinthTeamMember[]>(
      endpoint(source.api, `team/${encodeURIComponent(teamId)}/members`),
      { signal },
    )
    const list = Array.isArray(members) ? members : []
    const owner = list.find((member) => member.role?.toLowerCase() === 'owner')
    return owner?.user?.username?.trim() || list[0]?.user?.username?.trim() || ''
  } catch (cause) {
    if (signal.aborted) throw cause
    return ''
  }
}

/** 读取单个项目的完整摘要；前置跳转时用来补齐详情页头部 */
export async function projectModrinth(
  source: ModSource,
  projectId: string,
  signal: AbortSignal,
  kind: ModProjectKind = 'mod',
): Promise<ModSummary> {
  const project = await requestJson<ModrinthProject>(
    endpoint(source.api, `project/${encodeURIComponent(projectId)}`),
    { signal },
  )
  const summary = projectSummary(source, project, kind)
  if (!summary) throw new Error('Modrinth 没有返回有效的项目信息')
  const author = await projectAuthor(source, project.team, signal)
  return { ...summary, author }
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
  const data = Array.isArray(response) ? response : []
  const projects = await dependencyProjects(source, data, signal)
  const versions = data
    .map((version) => versionOf(source, request.projectId, version, projects))
    .filter((version): version is ModVersion => version !== null)

  versions.sort((a, b) => b.published.localeCompare(a.published))
  return versions
}
