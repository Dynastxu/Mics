import type { Context } from 'cordis'
import { isPackKind, waterfallEvent } from '@mics/sdk'
import type {
  CatalogDescriptor,
  ModProjectKind,
  ModSummary,
  RpcRequest,
  RpcResponse
} from '@mics/sdk'

/**
 * 目录文案改写。
 *
 * 主进程的目录 RPC 在返回渲染端之前经过这里：把 `ModSummary` 的 `name` /
 * `summary` 交给 `catalog/describe` 事件。缓存、搜索与指纹识别仍然只看到来源
 * 原文，翻译插件拿到的是一份展示副本，未命中时原样返回即可。
 *
 * 这里吞掉监听器的异常并回退原文：任何翻译插件都不应该让下载目录打不开。
 */

type DebugLog = (message: string, ...args: unknown[]) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSummary(value: unknown): value is ModSummary {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.slug === 'string' &&
    (value.source === 'modrinth' || value.source === 'curseforge')
  )
}

/** 请求对应的目录项目类型；无法确定时返回 null，宁可不改写也不猜错 */
function kindOf(request: RpcRequest): ModProjectKind | null {
  if (request.method.startsWith('mods/')) return 'mod'
  if (request.method.startsWith('modpacks/')) return 'modpack'
  if (request.method.startsWith('packs/')) {
    const params = request.params
    const kind = isRecord(params) ? params.kind : undefined
    return isPackKind(kind) ? kind : null
  }
  return null
}

/** 单个摘要：派发 `catalog/describe`，监听器没有改写时复用原对象 */
async function describeSummary(
  ctx: Context,
  kind: ModProjectKind,
  summary: ModSummary
): Promise<ModSummary> {
  const base: CatalogDescriptor = {
    kind,
    id: summary.id,
    source: summary.source,
    projectId: summary.projectId,
    slug: summary.slug,
    name: summary.name,
    summary: summary.summary
  }
  const described = await waterfallEvent(ctx, 'catalog/describe', base, async () => ({ ...base }))
  const name = typeof described?.name === 'string' ? described.name.trim() : ''
  const text = typeof described?.summary === 'string' ? described.summary.trim() : ''
  const nextName = name ? described.name : summary.name
  const nextSummary = text ? described.summary : summary.summary
  if (nextName === summary.name && nextSummary === summary.summary) return summary
  return {
    ...summary,
    name: nextName,
    summary: nextSummary,
    // 展示名被改写时留下原文：复制名称 / 到官网搜索都需要未被翻译的英文名
    ...(nextName === summary.name ? {} : { originalName: summary.originalName ?? summary.name })
  }
}

async function describeSearch(
  ctx: Context,
  kind: ModProjectKind,
  value: unknown
): Promise<unknown> {
  if (!isRecord(value) || !Array.isArray(value.items)) return value
  const items = value.items
  const described = await Promise.all(
    items.map((item) => (isSummary(item) ? describeSummary(ctx, kind, item) : item))
  )
  if (!described.some((item, index) => item !== items[index])) return value
  return { ...value, items: described }
}

async function describeVersions(
  ctx: Context,
  kind: ModProjectKind,
  value: unknown
): Promise<unknown> {
  if (!Array.isArray(value)) return value
  // 版本声明的依赖在 Mod / 整合包里都是 Mod，不是当前目录的项目类型
  const dependencyKind: ModProjectKind = kind === 'mod' || kind === 'modpack' ? 'mod' : kind
  let changed = false
  const versions = await Promise.all(
    value.map(async (version) => {
      if (!isRecord(version) || !Array.isArray(version.dependencies)) return version
      const dependencies = version.dependencies
      const described = await Promise.all(
        dependencies.map(async (dependency) => {
          if (!isRecord(dependency) || !isSummary(dependency.project)) return dependency
          const project = await describeSummary(ctx, dependencyKind, dependency.project)
          return project === dependency.project ? dependency : { ...dependency, project }
        })
      )
      if (!described.some((item, index) => item !== dependencies[index])) return version
      changed = true
      return { ...version, dependencies: described }
    })
  )
  return changed ? versions : value
}

async function describeIdentities(ctx: Context, value: unknown): Promise<unknown> {
  if (!Array.isArray(value)) return value
  let changed = false
  const identities = await Promise.all(
    value.map(async (identity) => {
      if (!isRecord(identity) || !isSummary(identity.project)) return identity
      const project = await describeSummary(ctx, 'mod', identity.project)
      if (project === identity.project) return identity
      changed = true
      return { ...identity, project }
    })
  )
  return changed ? identities : value
}

async function describeValue(
  ctx: Context,
  kind: ModProjectKind,
  method: string,
  value: unknown
): Promise<unknown> {
  const action = method.slice(method.indexOf('/') + 1)
  switch (action) {
    case 'search':
      return describeSearch(ctx, kind, value)
    case 'project':
      return isSummary(value) ? describeSummary(ctx, kind, value) : value
    case 'versions':
      return describeVersions(ctx, kind, value)
    case 'identify':
      return describeIdentities(ctx, value)
    default:
      return value
  }
}

/**
 * 改写一次目录 RPC 的返回值。
 *
 * 只处理 `RpcResponse.ok === true` 的响应；未改变内容时返回原来的响应对象，
 * 避免给渲染进程制造无意义的差异。
 */
export async function describeResponse(
  ctx: Context,
  request: RpcRequest,
  response: RpcResponse,
  debug?: DebugLog
): Promise<RpcResponse> {
  if (!response.ok) return response
  const kind = kindOf(request)
  if (!kind) return response
  try {
    const value = await describeValue(ctx, kind, request.method, response.value)
    return value === response.value ? response : { ...response, value }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    debug?.('目录文案改写失败，回退原文：%s', message)
    return response
  }
}
