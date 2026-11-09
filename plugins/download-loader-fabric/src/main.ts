import type { Context } from 'cordis'
import { DEFAULT_LOADER_SOURCES, normalizeLoaderSources } from '@mics/sdk'
import type {
  LoaderPrepareInput,
  LoaderPrepareResult,
  LoaderProvider,
  LoaderRuntime,
  LoaderSource,
  LoaderSourceKind,
  LoaderVersion
} from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import {
  fetchFirst,
  loaderEndpointsFor,
  metadataCandidates,
  normalizeLoaderLibraries,
  OFFICIAL_LOADER_BASES
} from '@mics/sdk/main'
import type { VersionDetail } from '@mics/sdk'

export const name = 'mics.download.loader.fabric'
export const inject = ['loaders', 'storage', 'host']

/**
 * Fabric：meta 服务直接给出「按游戏版本过滤的加载器版本列表」和
 * 可执行的自包含 profile，安装时不需要额外运行安装器。
 */

interface MetaApi {
  /** 版本清单接口的版本号（v2） */
  api: 'v2'
}

const META: MetaApi = { api: 'v2' }
const KIND: LoaderSourceKind = 'fabric'

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 解析 meta 的加载器列表。
 *
 * 不同版本的 meta 可能把 `version` / `stable` 直接放在条目上，也可能包在
 * `loader` 里，这里一起接受。
 */
export function parseMetaLoaderVersions(value: unknown, gameVersion: string): LoaderVersion[] {
  if (!Array.isArray(value)) return []

  const versions: LoaderVersion[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = recordOf(entry)
    if (!record) continue
    const nested = recordOf(record.loader)
    const id = stringOf(record.version) || stringOf(nested?.version)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const stable = booleanOf(record.stable, booleanOf(nested?.stable, true))
    versions.push({
      id,
      gameVersion,
      channel: stable ? 'stable' : 'beta',
      // meta 列表不带发布日期；渲染端留空，不伪造时间
      date: ''
    })
  }
  return versions
}

function parseProfile(value: unknown, gameVersion: string): LoaderPrepareResult {
  const record = recordOf(value)
  const versionId = stringOf(record?.id)
  if (!record || !versionId) throw new Error('加载器版本档案缺少版本 id')

  const libraries = Array.isArray(record.libraries)
    ? (record.libraries as VersionDetail['libraries'])
    : []
  const version: VersionDetail = {
    ...(record as unknown as VersionDetail),
    id: versionId,
    inheritsFrom: stringOf(record.inheritsFrom) || gameVersion,
    libraries: normalizeLoaderLibraries(libraries ?? [], OFFICIAL_LOADER_BASES[KIND].maven)
  }
  return { versionId, version, mode: 'profile' }
}

function defaultSources(): LoaderSource[] {
  return normalizeLoaderSources(
    DEFAULT_LOADER_SOURCES.filter((source) => source.kind === KIND).map((source) => ({ ...source }))
  )
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.loader.fabric')

  function sources(): LoaderSource[] {
    const raw = ctx.storage.get<string>('sources', '')
    if (raw) {
      try {
        const parsed = normalizeLoaderSources(JSON.parse(raw))
        const own = parsed.filter((source) => source.kind === KIND)
        if (own.length > 0) return own
      } catch {
        /* 落到默认值 */
      }
    }
    return defaultSources()
  }

  function setSources(next: LoaderSource[]): void {
    ctx.storage.set(
      'sources',
      JSON.stringify(normalizeLoaderSources(next.filter((source) => source.kind === KIND)))
    )
  }

  async function fetchMeta(path: string, signal: AbortSignal): Promise<unknown> {
    const targets = metadataCandidates(sources(), KIND, path)
    return fetchFirst(targets, {
      signal,
      appVersion: ctx.host.app.version,
      parse: (text) => JSON.parse(text) as unknown
    })
  }

  const provider: LoaderProvider = {
    kind: KIND,

    sources,
    setSources,

    async listVersions(gameVersion, signal) {
      const raw = await fetchMeta(
        `/${META.api}/versions/loader/${encodeURIComponent(gameVersion)}`,
        signal
      )
      return parseMetaLoaderVersions(raw, gameVersion)
    },

    async prepare(input: LoaderPrepareInput, runtime: LoaderRuntime) {
      runtime.report('获取 Fabric 加载器档案')
      const raw = await fetchMeta(
        `/${META.api}/versions/loader/${encodeURIComponent(input.gameVersion)}` +
          `/${encodeURIComponent(input.loaderVersion)}/profile/json`,
        input.signal
      )
      const plan = parseProfile(raw, input.gameVersion)
      runtime.log('info', `Fabric 档案已就绪：${plan.versionId}`)
      return { ...plan, sourcesFor: (url) => loaderEndpointsFor(url, sources()) }
    }
  }

  ctx.effect(() => ctx.loaders.register(provider))
  log.info('Fabric 加载器已就绪（%d 个源）', sources().length)
}

export default defineMainPlugin({ name, inject, apply })
