import type { Context } from 'cordis'
import { Service } from 'cordis'
import {
  isModLoader,
  isPackKind,
  listModCategories,
  listModpackCategories,
  MOD_SOURCE_LABELS,
  serialEvent
} from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import type {
  CatalogFileRef,
  CatalogRegistry,
  CatalogResolvedFile,
  CatalogSource,
  ModCategory,
  ModIdentifyRequest,
  ModIdentity,
  ModProjectKind,
  ModProjectRequest,
  ModSearchRequest,
  ModSearchResult,
  ModSource,
  ModSourceError,
  ModSourceInfo,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
  PackKind
} from '@mics/sdk'
import { describeResponse } from './describe'

export const name = 'mics.download.catalog'
export const inject = ['ipc', 'storage']
export const dependencies = ['mics.download.manager']

/**
 * 社区目录聚合。
 *
 * 每个来源插件注册自己的 `CatalogSource`；这里只负责合并、分页、缓存、
 * 来源状态与 `catalog/describe`，不认识任何来源的字段。
 */

const MAX_FETCH = 400
const MOD_SEARCH_TTL = 90 * 1000
const MOD_VERSION_TTL = 5 * 60 * 1000
const MOD_IDENTITY_TTL = 6 * 60 * 60 * 1000
const MOD_CACHE_LIMIT = 64
const MOD_METADATA_TIMEOUT = 40 * 1000

function sourceErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /abort/i.test(message) ? '请求超时' : message
}

class CatalogRegistryService extends Service implements CatalogRegistry {
  private readonly sourcesByKind = new Map<ModSourceKind, CatalogSource>()
  private readonly pendingLegacy = new Map<ModSourceKind, ModSource[]>()

  constructor(ctx: Context) {
    super(ctx, 'catalog')
  }

  register(source: CatalogSource) {
    this.sourcesByKind.set(source.kind, source)
    const pending = this.pendingLegacy.get(source.kind)
    if (pending) {
      source.setSources(pending)
      this.pendingLegacy.delete(source.kind)
    }
    return () => {
      if (this.sourcesByKind.get(source.kind) === source) this.sourcesByKind.delete(source.kind)
    }
  }

  list(): CatalogSource[] {
    return [...this.sourcesByKind.values()]
  }

  get(kind: ModSourceKind): CatalogSource | undefined {
    return this.sourcesByKind.get(kind)
  }

  /** 旧下载插件保存的 Mod 来源：按 kind 分发给对应插件 */
  applyLegacy(sources: ModSource[]): void {
    const grouped = new Map<ModSourceKind, ModSource[]>()
    for (const source of sources) {
      if (!source || typeof source.kind !== 'string') continue
      const list = grouped.get(source.kind) ?? []
      list.push(source)
      grouped.set(source.kind, list)
    }
    for (const [kind, list] of grouped) {
      const source = this.sourcesByKind.get(kind)
      if (source) source.setSources(list)
      else this.pendingLegacy.set(kind, list)
    }
  }
}

function normalizeModSearch(request: ModSearchRequest): ModSearchRequest {
  const page = Number.isInteger(request?.page) && request.page > 0 ? request.page : 1
  const rawSize = Number.isInteger(request?.pageSize) ? Number(request.pageSize) : 20
  const pageSize = Math.max(1, Math.min(50, rawSize))
  const source =
    request?.source === 'curseforge' || request?.source === 'modrinth' ? request.source : 'all'
  const loader = isModLoader(request?.loader) ? request.loader : 'all'
  return {
    query: typeof request?.query === 'string' ? request.query.trim().slice(0, 120) : '',
    source,
    gameVersion: typeof request?.gameVersion === 'string' ? request.gameVersion.trim() : '',
    loader,
    category: typeof request?.category === 'string' ? request.category.trim() : '',
    page,
    pageSize
  }
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.catalog')
  const registry = new CatalogRegistryService(ctx)

  const searchCache = new Map<string, { at: number; value: ModSearchResult }>()
  const versionCache = new Map<string, { at: number; value: ModVersion[] }>()
  const projectCache = new Map<string, { at: number; value: ModSummary }>()
  const identityCache = new Map<string, { at: number; value: ModIdentity[] }>()

  function readCache<T>(
    cache: Map<string, { at: number; value: T }>,
    key: string,
    ttl: number
  ): T | undefined {
    const cached = cache.get(key)
    if (!cached) return undefined
    if (Date.now() - cached.at > ttl) {
      cache.delete(key)
      return undefined
    }
    return cached.value
  }

  function writeCache<T>(
    cache: Map<string, { at: number; value: T }>,
    key: string,
    value: T
  ): void {
    if (cache.size >= MOD_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { at: Date.now(), value })
  }

  function categoriesOf(kind: ModProjectKind): ModCategory[] {
    if (kind === 'mod') return listModCategories()
    if (kind === 'modpack') return listModpackCategories()
    return []
  }

  function sourceInfos(): ModSourceInfo[] {
    return registry.list().map((source) => source.info())
  }

  async function search(request: ModSearchRequest, kind: ModProjectKind): Promise<ModSearchResult> {
    const normalized = normalizeModSearch(request)
    const cacheKey = `${kind}:${JSON.stringify(normalized)}`
    const cached = readCache(searchCache, cacheKey, MOD_SEARCH_TTL)
    if (cached) return cached

    const selected = registry.list().filter((source) => {
      const entries = source.sources()
      return (
        entries.some((entry) => entry.enabled) &&
        (normalized.source === 'all' || source.kind === normalized.source)
      )
    })
    if (selected.length === 0) {
      throw new Error(
        normalized.source === 'all'
          ? '未启用任何下载源'
          : `未启用 ${MOD_SOURCE_LABELS[normalized.source]} 下载源`
      )
    }

    const usable = selected.filter((source) => source.ready())
    if (usable.length === 0) {
      throw new Error(selected[0]?.info().hint ?? '没有可用的下载源')
    }

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), MOD_METADATA_TIMEOUT)
    let settled: PromiseSettledResult<ModSearchResult>[]
    try {
      settled = await Promise.allSettled(
        usable.map((source) => source.search(normalized, kind, abort.signal))
      )
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }

    const errors: ModSourceError[] = []
    const merged = new Map<string, ModSummary>()
    let total = 0
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        const source = usable[index]
        if (source) {
          errors.push({
            source: source.kind,
            label: source.info().label,
            message: sourceErrorMessage(outcome.reason)
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
      (a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name)
    )
    const offset = (normalized.page - 1) * normalized.pageSize
    const result: ModSearchResult = {
      items: ordered.slice(offset, offset + normalized.pageSize),
      total: Math.min(total, MAX_FETCH),
      page: normalized.page,
      pageSize: normalized.pageSize,
      errors
    }
    if (errors.length === 0) writeCache(searchCache, cacheKey, result)
    return result
  }

  async function versions(request: ModVersionRequest, kind: ModProjectKind): Promise<ModVersion[]> {
    if (!request || (request.source !== 'curseforge' && request.source !== 'modrinth')) {
      throw new Error('不支持的下载源')
    }
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error('无效的项目 id')

    const normalized: ModVersionRequest = {
      source: request.source,
      ...(request.sourceApi ? { sourceApi: request.sourceApi } : {}),
      projectId,
      gameVersion: typeof request.gameVersion === 'string' ? request.gameVersion.trim() : '',
      loader: isModLoader(request.loader) ? request.loader : 'all'
    }
    const cacheKey = `${kind}:${normalized.source}:${normalized.sourceApi ?? ''}:${normalized.projectId}:${normalized.gameVersion}:${normalized.loader}`
    const cached = readCache(versionCache, cacheKey, MOD_VERSION_TTL)
    if (cached) return cached

    const source = registry.get(normalized.source)
    if (!source) throw new Error(`未安装 ${MOD_SOURCE_LABELS[normalized.source]} 来源插件`)
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), MOD_METADATA_TIMEOUT)
    try {
      const list = await source.versions(normalized, kind, abort.signal)
      writeCache(versionCache, cacheKey, list)
      return list
    } catch (cause) {
      throw new Error(sourceErrorMessage(cause), { cause })
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  }

  async function project(request: ModProjectRequest, kind: ModProjectKind): Promise<ModSummary> {
    if (!request || (request.source !== 'curseforge' && request.source !== 'modrinth')) {
      throw new Error('不支持的下载源')
    }
    const projectId = typeof request.projectId === 'string' ? request.projectId.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error('无效的项目 id')

    const normalized: ModProjectRequest = {
      source: request.source,
      ...(request.sourceApi ? { sourceApi: request.sourceApi } : {}),
      projectId
    }
    const cacheKey = `${kind}:${normalized.source}:${normalized.sourceApi ?? ''}:${normalized.projectId}`
    const cached = readCache(projectCache, cacheKey, MOD_VERSION_TTL)
    if (cached) return cached

    const source = registry.get(normalized.source)
    if (!source) throw new Error(`未安装 ${MOD_SOURCE_LABELS[normalized.source]} 来源插件`)
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), MOD_METADATA_TIMEOUT)
    try {
      const summary = await source.project(normalized, kind, abort.signal)
      writeCache(projectCache, cacheKey, summary)
      return summary
    } catch (cause) {
      throw new Error(sourceErrorMessage(cause), { cause })
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  }

  async function identify(request: ModIdentifyRequest): Promise<ModIdentity[]> {
    const rawFiles = Array.isArray(request?.files) ? request.files.slice(0, 256) : []
    const files = rawFiles.filter(
      (file) => file && typeof file.key === 'string' && (file.sha1 || file.murmur2 !== undefined)
    )
    if (files.length === 0) return []

    const cacheKey = files
      .map((file) => `${file.key}:${file.sha1 ?? ''}:${file.murmur2 ?? ''}`)
      .sort()
      .join('|')
    const cached = readCache(identityCache, cacheKey, MOD_IDENTITY_TTL)
    if (cached) return cached

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), MOD_METADATA_TIMEOUT)
    try {
      const settled = await Promise.allSettled(
        registry.list().map(async (source) => ({
          source,
          hits: await source.identify(files, abort.signal)
        }))
      )
      const chosen = new Map<string, ModIdentity>()
      const order = ['modrinth', 'curseforge']
      settled.sort((a, b) => {
        if (a.status !== 'fulfilled' || b.status !== 'fulfilled') return 0
        return order.indexOf(a.value.source.kind) - order.indexOf(b.value.source.kind)
      })
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue
        for (const identity of outcome.value.hits) {
          if (!chosen.has(identity.key)) chosen.set(identity.key, identity)
        }
      }
      const result = files
        .map((file) => chosen.get(file.key))
        .filter((identity): identity is ModIdentity => identity !== undefined)
      if (result.length > 0) writeCache(identityCache, cacheKey, result)
      return result
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  }

  // -------------------------------------------------------------------------
  // 注册表 RPC
  // -------------------------------------------------------------------------

  ctx.ipc.handle('sources/get', (): ModSource[] =>
    registry.list().flatMap((source) => source.sources())
  )

  ctx.ipc.handle<{ sources: ModSource[] }>('sources/set', ({ sources }) => {
    const grouped = new Map<ModSourceKind, ModSource[]>()
    for (const source of Array.isArray(sources) ? sources : []) {
      if (!source || (source.kind !== 'modrinth' && source.kind !== 'curseforge')) continue
      const list = grouped.get(source.kind) ?? []
      list.push(source)
      grouped.set(source.kind, list)
    }
    for (const [kind, list] of grouped) registry.get(kind)?.setSources(list)
    searchCache.clear()
    versionCache.clear()
    projectCache.clear()
    identityCache.clear()
    log.info('Mod 下载源已更新')
  })

  // -------------------------------------------------------------------------
  // 目录 RPC（保持原有命名，页面只换 target）
  // -------------------------------------------------------------------------

  ctx.ipc.handle('mods/sources', () => sourceInfos())
  ctx.ipc.handle('mods/categories', () => categoriesOf('mod'))
  ctx.ipc.handle<ModSearchRequest>('mods/search', (request) => search(request, 'mod'))
  ctx.ipc.handle<ModVersionRequest>('mods/versions', (request) => versions(request, 'mod'))
  ctx.ipc.handle<ModProjectRequest>('mods/project', (request) => project(request, 'mod'))
  ctx.ipc.handle<ModIdentifyRequest>('mods/identify', (request) => identify(request))

  ctx.ipc.handle('modpacks/sources', () => sourceInfos())
  ctx.ipc.handle('modpacks/categories', () => categoriesOf('modpack'))
  ctx.ipc.handle<ModSearchRequest>('modpacks/search', (request) => search(request, 'modpack'))
  ctx.ipc.handle<ModVersionRequest>('modpacks/versions', (request) => versions(request, 'modpack'))
  ctx.ipc.handle<ModProjectRequest>('modpacks/project', (request) => project(request, 'modpack'))

  ctx.ipc.handle<{ kind?: PackKind }>('packs/sources', () => sourceInfos())
  ctx.ipc.handle<{ kind?: PackKind }>('packs/categories', () => [])
  ctx.ipc.handle<ModSearchRequest & { kind?: PackKind }>('packs/search', (request) => {
    if (!isPackKind(request?.kind)) throw new Error('不支持的资源类型')
    return search(request, request.kind)
  })
  ctx.ipc.handle<ModVersionRequest & { kind?: PackKind }>('packs/versions', (request) => {
    if (!isPackKind(request?.kind)) throw new Error('不支持的资源类型')
    return versions(request, request.kind)
  })
  ctx.ipc.handle<ModProjectRequest & { kind?: PackKind }>('packs/project', (request) => {
    if (!isPackKind(request?.kind)) throw new Error('不支持的资源类型')
    return project(request, request.kind)
  })

  // -------------------------------------------------------------------------
  // 整合包文件解析
  // -------------------------------------------------------------------------

  ctx.on(
    'catalog/resolveModpackFiles',
    async (request: {
      refs: CatalogFileRef[]
      sourceApi?: string
    }): Promise<CatalogResolvedFile[]> => {
      const source = registry.get('curseforge')
      if (!source) throw new Error('未安装 CurseForge 来源插件')
      if (!source.ready()) {
        throw new Error('整合包包含 CurseForge 文件，但 CurseForge 下载源不可用（缺少 API Key）')
      }
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), MOD_METADATA_TIMEOUT)
      try {
        return await source.resolveModpackFiles(request.refs, abort.signal)
      } finally {
        clearTimeout(timeout)
        abort.abort()
      }
    }
  )

  // -------------------------------------------------------------------------
  // 目录文案改写 + 旧配置导入
  // -------------------------------------------------------------------------

  ctx.on('ipc/before', async (request, next) => {
    const response = await next()
    if (!response.ok || request.target !== name) return response
    return describeResponse(ctx, request, response, (message, ...args) =>
      log.debug(message, ...args)
    )
  })

  if (!ctx.storage.get<boolean>('legacyImported')) {
    void serialEvent(ctx, 'download/legacy-config')
      .then((legacy) => {
        if (Array.isArray(legacy?.modSources) && legacy.modSources.length > 0) {
          registry.applyLegacy(legacy.modSources)
          log.info('已从旧下载插件导入 Mod 下载源')
        }
        ctx.storage.set('legacyImported', true)
      })
      .catch(() => undefined)
  }
}

export default defineMainPlugin({ name, inject, apply })
