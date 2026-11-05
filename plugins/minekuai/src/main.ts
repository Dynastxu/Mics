import type { Context } from 'cordis'
import { MOD_PROJECT_KINDS } from '@mics/sdk'
import type { CatalogDescriptor, ModProjectKind, ModSourceKind } from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import { MineKuaiLookup } from './lookup'
import { readMineKuaiSettings } from './settings'

export const name = 'mics.minekuai'
export const inject = ['ipc', 'storage']

interface ResolveRequest {
  kind?: unknown
  name?: unknown
  summary?: unknown
  projectId?: unknown
  slug?: unknown
  source?: unknown
}

interface SearchRequest {
  kind?: unknown
  query?: unknown
}

interface ResolveResult {
  name: string
  summary: string
  matched: boolean
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function kindOf(value: unknown): ModProjectKind | null {
  if (typeof value !== 'string') return null
  return (MOD_PROJECT_KINDS as readonly string[]).includes(value) ? (value as ModProjectKind) : null
}

function sourceOf(value: unknown): ModSourceKind {
  return value === 'curseforge' ? 'curseforge' : 'modrinth'
}

/**
 * 把 RPC 参数收敛成目录描述；名称必填，其余缺失时退回空串。
 *
 * 这不是信任边界：真正参与匹配的只有 `name` / `summary` 与可选的
 * `projectId` / `slug`，其余字段只用于候选排序。
 */
function descriptorOf(request: ResolveRequest): CatalogDescriptor | null {
  const kind = kindOf(request?.kind)
  const name = textOf(request?.name)
  if (!kind || !name) return null
  const source = sourceOf(request?.source)
  const projectId = textOf(request?.projectId)
  const slug = textOf(request?.slug) || projectId
  return {
    kind,
    id: `${source}:${projectId || slug || name}`,
    source,
    projectId,
    slug,
    name,
    summary: textOf(request?.summary)
  }
}

/**
 * 麦块开放API（主进程）。
 *
 * 只做两件事：监听 `catalog/describe` 改写目录展示文案，以及暴露查询 RPC 给
 * 其它插件 / agent。所有响应都经过 `translateFromCandidates` 的英文完全
 * 一致校验；未命中、超时或接口失败时返回原文，不阻塞目录打开。
 */
export function apply(ctx: Context): void {
  const log = ctx.logger('mics.minekuai')
  const lookup = new MineKuaiLookup(() => readMineKuaiSettings(ctx.storage), log)

  ctx.on('catalog/describe', async (descriptor, next) => {
    const current = await next()
    try {
      const settings = readMineKuaiSettings(ctx.storage)
      if (!settings.enabled) return current
      const translation = await lookup.resolve(descriptor)
      if (!translation) return current
      return {
        ...current,
        ...(translation.name ? { name: translation.name } : {}),
        ...(translation.summary ? { summary: translation.summary } : {})
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      log.debug('目录翻译失败，保留原文：%s', message)
      return current
    }
  })

  /** 原始查询：返回 `title` / `description_en` 与对应中文并存的条目 */
  ctx.ipc.handle<SearchRequest>('search', async (request) => {
    const kind = kindOf(request?.kind)
    if (!kind) throw new Error('不支持的目录类型')
    const query = textOf(request?.query)
    if (!query) return []
    return lookup.search(kind, query)
  })

  /** 精确解析：英文与原文完全一致才返回中文，否则返回原文 */
  ctx.ipc.handle<ResolveRequest>('resolve', async (request): Promise<ResolveResult> => {
    const descriptor = descriptorOf(request ?? {})
    if (!descriptor) throw new Error('需要 kind 与 name')
    const translation = await lookup.resolve(descriptor)
    const name = translation?.name ?? descriptor.name
    const summary = translation?.summary ?? descriptor.summary
    return {
      name,
      summary,
      matched: name !== descriptor.name || summary !== descriptor.summary
    }
  })

  /** 诊断：当前设置与缓存规模 */
  ctx.ipc.handle('status', () => {
    const settings = readMineKuaiSettings(ctx.storage)
    return { ...settings, cache: lookup.stats() }
  })

  /** 清空查询与译文缓存，下一次目录请求重新取数 */
  ctx.ipc.handle('clear', () => {
    lookup.clear()
    return lookup.stats()
  })

  const settings = readMineKuaiSettings(ctx.storage)
  log.info(
    '麦块开放API 就绪：%s（目录翻译%s）',
    settings.baseUrl,
    settings.enabled ? '已启用' : '已关闭'
  )
}

export default defineMainPlugin({ name, inject, apply })
