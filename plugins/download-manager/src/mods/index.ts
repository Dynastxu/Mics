import type {
  ModCategory,
  ModIdentifyFile,
  ModIdentity,
  ModProjectKind,
  ModProjectRequest,
  ModSearchRequest,
  ModSearchResult,
  ModSource,
  ModSourceError,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
} from '@mics/sdk'
import { MOD_SOURCE_LABELS } from '@mics/sdk'
import { listModCategories } from './categories'
import {
  curseforgeReady,
  identifyCurseforge,
  projectCurseforge,
  searchCurseforge,
  versionsCurseforge,
} from './curseforge'
import { identifyModrinth, projectModrinth, searchModrinth, versionsModrinth } from './modrinth'

/**
 * 多来源聚合。
 *
 * 每个来源独立搜索，一个来源失败不影响其它来源；合并后按下载量排序，页面
 * 只需要处理一份结果。分页采用「每个来源取前 N 条 -> 全局排序 -> 切片」，
 * 这样跨来源的页码与排序是稳定的，而不是各来源页码交错。
 */

/**
 * 跨来源分页最多取回多少条。
 *
 * 全局按下载量排序要求先拿到「前 N 条」再切片，不能像单来源那样直接按
 * 服务端 offset 翻页；因此限制总深度，页面最多翻到第 20 页（每页 20 条）。
 * 想找更老的 Mod 应该用搜索或筛选缩小范围。
 */
const MAX_FETCH = 400

export function listCategories(): ModCategory[] {
  return listModCategories()
}

/** 官方 CurseForge 没有 API Key 时无法搜索；Modrinth 永远可用 */
export function modSourceReady(source: ModSource): boolean {
  if (!source.enabled) return false
  if (source.kind === 'curseforge') return curseforgeReady(source)
  return true
}

function unavailableMessage(source: ModSource): string {
  if (source.kind === 'curseforge') {
    return 'CurseForge 需要 API Key，请在「下载设置 → Mod 下载源」中填写'
  }
  return `${MOD_SOURCE_LABELS[source.kind]} 下载源不可用`
}

/** Node 的 AbortError 对用户没有意义，统一显示成可理解的原因 */
function sourceErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /abort/i.test(message) ? '请求超时' : message
}

export async function searchMods(
  sources: ModSource[],
  request: ModSearchRequest,
  signal: AbortSignal,
  kind: ModProjectKind = 'mod',
): Promise<ModSearchResult> {
  const selected = sources.filter(
    (source) => source.enabled && (request.source === 'all' || source.kind === request.source),
  )
  if (selected.length === 0) {
    throw new Error(request.source === 'all'
      ? '未启用任何 Mod 下载源'
      : `未启用 ${MOD_SOURCE_LABELS[request.source]} 下载源`)
  }

  const usable = selected.filter(modSourceReady)
  if (usable.length === 0) throw new Error(unavailableMessage(selected[0]!))

  const limit = Math.min(MAX_FETCH, Math.max(request.pageSize, request.page * request.pageSize))
  const settled = await Promise.allSettled(
    usable.map(async (source) => {
      const result = source.kind === 'curseforge'
        ? await searchCurseforge(source, request, signal, limit, kind)
        : await searchModrinth(source, request, signal, limit, kind)
      return { source, ...result }
    }),
  )

  const errors: ModSourceError[] = []
  const merged = new Map<string, ModSummary>()
  let total = 0

  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      const source = usable[index]
      if (source) {
        errors.push({
          source: source.kind,
          label: source.label.trim() || MOD_SOURCE_LABELS[source.kind],
          message: sourceErrorMessage(outcome.reason),
        })
      }
      continue
    }

    total += outcome.value.total
    for (const item of outcome.value.items) {
      const existing = merged.get(item.id)
      if (!existing || item.downloads > existing.downloads) merged.set(item.id, item)
    }
  }

  const ordered = [...merged.values()].sort(
    (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name),
  )
  const offset = (request.page - 1) * request.pageSize

  return {
    items: ordered.slice(offset, offset + request.pageSize),
    // 页码上限与可翻到的结果数保持一致，避免出现点进去永远是空的尾页
    total: Math.min(total, MAX_FETCH),
    page: request.page,
    pageSize: request.pageSize,
    errors,
  }
}

/** 在已启用的来源里挑选实际使用的那一个；sourceApi 用于锁定命中的镜像 */
export function resolveModSource(
  sources: ModSource[],
  kind: ModSourceKind,
  sourceApi: string | undefined,
): ModSource {
  const matching = sources.filter((candidate) => candidate.enabled && candidate.kind === kind)
  if (matching.length === 0) {
    throw new Error(`未启用 ${MOD_SOURCE_LABELS[kind]} 下载源`)
  }
  const source = (sourceApi
    ? matching.find((candidate) => modSourceReady(candidate) && candidate.api === sourceApi)
    : undefined) ?? matching.find(modSourceReady)
  if (!source) throw new Error(unavailableMessage(matching[0]!))
  return source
}

export async function listModVersions(
  sources: ModSource[],
  request: ModVersionRequest,
  signal: AbortSignal,
  kind: ModProjectKind = 'mod',
): Promise<ModVersion[]> {
  const source = resolveModSource(sources, request.source, request.sourceApi)
  return request.source === 'curseforge'
    ? versionsCurseforge(source, request, signal)
    : versionsModrinth(source, request, signal)
}

/**
 * 读取单个项目摘要。
 *
 * 版本列表里能拿到项目名、图标等基础信息，但 Modrinth 的作者要单独查；
 * 前置跳转时用它补齐详情页头部。
 */
export async function loadModProject(
  sources: ModSource[],
  request: ModProjectRequest,
  signal: AbortSignal,
  kind: ModProjectKind = 'mod',
): Promise<ModSummary> {
  const source = resolveModSource(sources, request.source, request.sourceApi)
  return request.source === 'curseforge'
    ? projectCurseforge(source, request.projectId, signal, kind)
    : projectModrinth(source, request.projectId, signal, kind)
}

/**
 * 指纹识别：并行询问所有可用的来源，按 Modrinth 优先、同类型按配置顺序
 * 选取第一个命中。
 *
 * 外部导入的 Mod 不需要经过 Mics 安装，只要 jar 字节能对上平台记录即可。
 */
export async function identifyMods(
  sources: ModSource[],
  files: ModIdentifyFile[],
  signal: AbortSignal,
): Promise<ModIdentity[]> {
  const usable = sources.filter(modSourceReady)
  if (usable.length === 0 || files.length === 0) return []

  // Modrinth 优先（与 PCL 的平台优先级一致），其余保持用户配置顺序
  const ordered = [...usable].sort((a, b) => {
    const rank = (source: ModSource): number => source.kind === 'modrinth' ? 0 : 1
    return rank(a) - rank(b)
  })

  const settled = await Promise.allSettled(
    ordered.map(async (source) => {
      const hits = source.kind === 'modrinth'
        ? await identifyModrinth(source, files, signal)
        : await identifyCurseforge(source, files, signal)
      return { source, hits }
    }),
  )

  const chosen = new Map<string, ModIdentity>()
  for (const outcome of settled) {
    if (outcome.status === 'rejected') continue
    const { source, hits } = outcome.value
    for (const [key, hit] of hits) {
      if (chosen.has(key)) continue
      chosen.set(key, {
        key,
        source: source.kind,
        sourceApi: source.api,
        sourceLabel: source.label.trim() || MOD_SOURCE_LABELS[source.kind],
        projectId: hit.projectId,
        versionId: hit.versionId,
        project: hit.project,
      })
    }
  }

  return files
    .map((file) => chosen.get(file.key))
    .filter((identity): identity is ModIdentity => identity !== undefined)
}
