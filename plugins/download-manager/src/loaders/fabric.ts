import type { LoaderSourceKind, LoaderVersion } from '@mics/sdk'
import { normalizeLoaderLibraries, type VersionDetail } from '../version'
import { OFFICIAL_LOADER_BASES } from './sources'
import type { LoaderInstallPlan, LoaderProvider } from './types'

/**
 * Fabric：meta 服务直接给出「按游戏版本过滤的加载器版本列表」和
 * 可执行的自包含 profile，安装时不需要额外运行安装器。
 */

interface MetaApi {
  /** 版本清单接口的版本号（v2） */
  api: 'v2'
}

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
      date: '',
    })
  }
  return versions
}

function parseProfile(value: unknown, gameVersion: string, kind: LoaderSourceKind): LoaderInstallPlan {
  const record = recordOf(value)
  const versionId = stringOf(record?.id)
  if (!record || !versionId) throw new Error('加载器版本档案缺少版本 id')

  const libraries = Array.isArray(record.libraries) ? (record.libraries as VersionDetail['libraries']) : []
  const version: VersionDetail = {
    ...(record as unknown as VersionDetail),
    id: versionId,
    inheritsFrom: stringOf(record.inheritsFrom) || gameVersion,
    libraries: normalizeLoaderLibraries(libraries ?? [], OFFICIAL_LOADER_BASES[kind].maven),
  }
  return { versionId, version, mode: 'profile' }
}

function createMetaProvider(kind: LoaderSourceKind, { api }: MetaApi): LoaderProvider {
  return {
    kind,

    async listVersions(gameVersion, env) {
      const raw = await env.fetchJson<unknown>(
        `/${api}/versions/loader/${encodeURIComponent(gameVersion)}`,
      )
      return parseMetaLoaderVersions(raw, gameVersion)
    },

    async install(input, env) {
      const raw = await env.fetchJson<unknown>(
        `/${api}/versions/loader/${encodeURIComponent(input.gameVersion)}`
        + `/${encodeURIComponent(input.loaderVersion)}/profile/json`,
      )
      const plan = parseProfile(raw, input.gameVersion, kind)
      env.log('info', `加载器档案已就绪：${plan.versionId}`)
      return plan
    },
  }
}

export const fabricProvider = createMetaProvider('fabric', { api: 'v2' })
