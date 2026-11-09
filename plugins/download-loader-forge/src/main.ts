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
  compareSegments,
  fetchFirst,
  installWithInstaller,
  isBmclHost,
  isPrerelease,
  loaderEndpointsFor,
  mergeLoaderVersions,
  metadataCandidates,
  originOf,
  parseMavenVersions,
  settleWithin
} from '@mics/sdk/main'

export const name = 'mics.download.loader.forge'
export const inject = ['loaders', 'storage', 'host']

/**
 * Forge：官方只发布安装器（installer.jar）。
 *
 * 安装器要求「类 .minecraft」的目标目录；实例目录不是这个形状，所以安装器
 * 跑在实例内的暂存目录里，装完把产物搬进实例（见 `@mics/sdk/main` 的
 * `installWithInstaller`）。
 */

const KIND: LoaderSourceKind = 'forge'

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Forge promotions_slim.json 的条目：recommended / latest 两档 */
export function parseForgePromotions(value: unknown, gameVersion: string): LoaderVersion[] {
  const promos = recordOf(recordOf(value)?.promos) ?? {}
  const recommended = stringOf(promos[`${gameVersion}-recommended`])
  const latest = stringOf(promos[`${gameVersion}-latest`])

  const versions: LoaderVersion[] = []
  if (recommended) {
    versions.push({ id: recommended, gameVersion, channel: 'stable', date: '' })
  }
  if (latest && latest !== recommended) {
    versions.push({
      id: latest,
      gameVersion,
      // 没有 recommended 时，latest 就是唯一可用的版本
      channel: recommended ? 'beta' : 'stable',
      date: ''
    })
  }
  return versions
}

/** BMCLAPI 的 Forge 列表：带完整版本、发布日期与分支 */
export function parseBmclForgeVersions(value: unknown, gameVersion: string): LoaderVersion[] {
  if (!Array.isArray(value)) return []
  const versions: LoaderVersion[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = recordOf(entry)
    if (!record) continue
    const mcVersion = stringOf(record.mcversion)
    if (mcVersion && mcVersion !== gameVersion) continue
    const id = stringOf(record.version)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const branch = stringOf(record.branch)
    const modified = stringOf(record.modified)
    versions.push({
      id,
      gameVersion,
      channel: branch === 'latest' || isPrerelease(id) ? 'beta' : 'stable',
      date: modified ? modified.slice(0, 10) : ''
    })
  }
  return versions
}

function defaultSources(): LoaderSource[] {
  return normalizeLoaderSources(
    DEFAULT_LOADER_SOURCES.filter((source) => source.kind === KIND).map((source) => ({ ...source }))
  )
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.loader.forge')

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

  async function fetchJsonUrl<T>(url: string, signal: AbortSignal): Promise<T> {
    return fetchFirst([url], {
      signal,
      appVersion: ctx.host.app.version,
      parse: (text) => JSON.parse(text) as T
    })
  }

  async function fetchLoaderJson(path: string, signal: AbortSignal): Promise<unknown> {
    return fetchFirst(metadataCandidates(sources(), KIND, path), {
      signal,
      appVersion: ctx.host.app.version,
      parse: (text) => JSON.parse(text) as unknown
    })
  }

  async function fetchLoaderText(
    path: string,
    role: 'meta' | 'maven',
    signal: AbortSignal
  ): Promise<string> {
    return fetchFirst(metadataCandidates(sources(), KIND, path, role), {
      signal,
      appVersion: ctx.host.app.version,
      parse: (text) => text
    })
  }

  /** Forge 的列表接口分散在官方与 BMCLAPI，按源类型分别请求后合并 */
  async function listVersions(gameVersion: string, signal: AbortSignal): Promise<LoaderVersion[]> {
    const requests: Array<Promise<LoaderVersion[]>> = []
    let hasFastSource = false

    for (const source of sources()) {
      if (!source.enabled) continue
      const origin = originOf(source.meta)
      if (!origin) continue

      if (isBmclHost(origin)) {
        hasFastSource = true
        requests.push(
          fetchJsonUrl<unknown>(
            `${origin}/forge/minecraft/${encodeURIComponent(gameVersion)}`,
            signal
          ).then((value) => parseBmclForgeVersions(value, gameVersion))
        )
        continue
      }

      requests.push(
        fetchLoaderJson('/net/minecraftforge/forge/promotions_slim.json', signal).then((value) =>
          parseForgePromotions(value, gameVersion)
        )
      )
    }

    // 有 BMCLAPI 速源时先等 1.5 秒；慢的官方 promotions 继续在后台补渠道信息
    let lists = hasFastSource ? await settleWithin(requests, 1500) : []
    if (lists.length === 0) {
      lists = (await Promise.allSettled(requests))
        .filter(
          (result): result is PromiseFulfilledResult<LoaderVersion[]> =>
            result.status === 'fulfilled'
        )
        .map((result) => result.value)
    }

    const versions = mergeLoaderVersions(lists)
    if (versions.length > 0) return versions

    // 旧版本或只镜像了 maven 的源：从 maven 元数据里筛选该游戏版本的 Forge
    const xml = await fetchLoaderText(
      '/net/minecraftforge/forge/maven-metadata.xml',
      'maven',
      signal
    )
    const prefix = `${gameVersion}-`
    return parseMavenVersions(xml)
      .filter((version) => version.startsWith(prefix))
      .sort((a, b) => compareSegments(b, a))
      .map((version) => ({
        id: version.slice(prefix.length),
        gameVersion,
        channel: isPrerelease(version) ? 'beta' : 'stable',
        date: ''
      }))
  }

  const provider: LoaderProvider = {
    kind: KIND,
    sources,
    setSources,
    listVersions,
    async prepare(input: LoaderPrepareInput, runtime: LoaderRuntime): Promise<LoaderPrepareResult> {
      const result = await installWithInstaller(KIND, input, runtime)
      return { ...result, sourcesFor: (url) => loaderEndpointsFor(url, sources()) }
    }
  }

  ctx.effect(() => ctx.loaders.register(provider))
  log.info('Forge 加载器已就绪（%d 个源）', sources().length)
}

export default defineMainPlugin({ name, inject, apply })
