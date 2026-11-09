import type { Context } from 'cordis'
import {
  DEFAULT_MOD_SOURCES,
  MOD_SOURCE_LABELS,
  listModCategories,
  listModpackCategories,
  normalizeModSources
} from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import type {
  CatalogFileRef,
  CatalogResolvedFile,
  CatalogSource,
  ModCategory,
  ModIdentifyFile,
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
  ModVersionRequest
} from '@mics/sdk'
import {
  identifyModrinth,
  projectModrinth,
  searchModrinth,
  versionsModrinth,
  type ModrinthIdentified
} from './api'
import { setHttpAppVersion } from './http'

export const name = 'mics.download.source.modrinth'
export const inject = ['catalog', 'storage', 'host']

const KIND: ModSourceKind = 'modrinth'
const MAX_FETCH = 400

function defaultSources(): ModSource[] {
  return normalizeModSources(
    DEFAULT_MOD_SOURCES.filter((source) => source.kind === KIND).map((source) => ({ ...source }))
  )
}

function sourceErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /abort/i.test(message) ? '请求超时' : message
}

/** 多镜像时按请求里的 sourceApi 锁定实际命中的来源 */
function pickSource(sources: ModSource[], api?: string): ModSource {
  const usable = sources.filter((source) => source.enabled)
  if (usable.length === 0) throw new Error(`未启用 ${MOD_SOURCE_LABELS[KIND]} 下载源`)
  const matched = api ? usable.find((source) => source.api === api) : undefined
  return matched ?? usable[0]!
}

class ModrinthSource implements CatalogSource {
  readonly kind = KIND

  constructor(private readonly ctx: Context) {}

  sources(): ModSource[] {
    const raw = this.ctx.storage.get<string>('sources', '')
    if (raw) {
      try {
        const parsed = normalizeModSources(JSON.parse(raw)).filter((source) => source.kind === KIND)
        if (parsed.length > 0) return parsed
      } catch {
        /* 落到默认值 */
      }
    }
    return defaultSources()
  }

  setSources(sources: ModSource[]): void {
    this.ctx.storage.set(
      'sources',
      JSON.stringify(normalizeModSources(sources.filter((source) => source.kind === KIND)))
    )
  }

  ready(): boolean {
    return this.sources().some((source) => source.enabled)
  }

  info(): ModSourceInfo {
    const source = this.sources().find((item) => item.enabled) ?? this.sources()[0]
    return {
      kind: KIND,
      label: source?.label.trim() || MOD_SOURCE_LABELS[KIND],
      enabled: Boolean(source?.enabled),
      ready: this.ready()
    }
  }

  categories(kind: ModProjectKind): ModCategory[] {
    if (kind === 'mod') return listModCategories()
    if (kind === 'modpack') return listModpackCategories()
    return []
  }

  async search(
    request: ModSearchRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModSearchResult> {
    const usable = this.sources().filter(
      (source) => source.enabled && (request.source === 'all' || request.source === KIND)
    )
    if (usable.length === 0) throw new Error(`未启用 ${MOD_SOURCE_LABELS[KIND]} 下载源`)

    const limit = Math.min(MAX_FETCH, Math.max(request.pageSize, request.page * request.pageSize))
    const settled = await Promise.allSettled(
      usable.map((source) => searchModrinth(source, request, signal, limit, kind))
    )

    const errors: ModSourceError[] = []
    const merged = new Map<string, ModSummary>()
    let total = 0
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        const source = usable[index]
        if (source) {
          errors.push({
            source: KIND,
            label: source.label.trim() || MOD_SOURCE_LABELS[KIND],
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
    // 分页由聚合层统一做：这里返回前 limit 条，避免各来源页码交错
    return {
      items: ordered.slice(0, limit),
      total: Math.min(total, MAX_FETCH),
      page: request.page,
      pageSize: request.pageSize,
      errors
    }
  }

  async versions(
    request: ModVersionRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModVersion[]> {
    const source = pickSource(this.sources(), request.sourceApi)
    return versionsModrinth(source, request, signal, kind)
  }

  async project(
    request: ModProjectRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModSummary> {
    const source = pickSource(this.sources(), request.sourceApi)
    return projectModrinth(source, request.projectId, signal, kind)
  }

  async identify(files: ModIdentifyFile[], signal: AbortSignal): Promise<ModIdentity[]> {
    const usable = this.sources().filter((source) => source.enabled)
    if (usable.length === 0) return []

    const settled = await Promise.allSettled(
      usable.map(async (source) => ({
        source,
        hits: await identifyModrinth(source, files, signal)
      }))
    )

    const chosen = new Map<string, { source: ModSource; hit: ModrinthIdentified }>()
    for (const outcome of settled) {
      if (outcome.status === 'rejected') continue
      for (const [key, hit] of outcome.value.hits) {
        if (!chosen.has(key)) chosen.set(key, { source: outcome.value.source, hit })
      }
    }

    return files
      .map((file): ModIdentity | undefined => {
        const match = chosen.get(file.key)
        if (!match) return undefined
        return {
          key: file.key,
          source: KIND,
          sourceApi: match.source.api,
          sourceLabel: match.source.label.trim() || MOD_SOURCE_LABELS[KIND],
          projectId: match.hit.projectId,
          versionId: match.hit.versionId,
          project: match.hit.project
        }
      })
      .filter((identity): identity is ModIdentity => identity !== undefined)
  }

  async resolveModpackFiles(
    _refs: CatalogFileRef[],
    _signal: AbortSignal
  ): Promise<CatalogResolvedFile[]> {
    throw new Error('Modrinth 整合包不需要按文件 id 解析')
  }
}

export function apply(ctx: Context): void {
  setHttpAppVersion(ctx.host.app.version)
  const source = new ModrinthSource(ctx)
  ctx.effect(() => ctx.catalog.register(source))
  ctx.logger('mics.download.source.modrinth').info('Modrinth 来源已就绪')
}

export default defineMainPlugin({ name, inject, apply })
