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
  metadataCandidates,
  originOf,
  parseMavenVersions,
  settleWithin
} from '@mics/sdk/main'

export const name = 'mics.download.loader.neoforge'
export const inject = ['loaders', 'storage', 'host']

/**
 * NeoForge：与 Forge 一样走官方安装器，但版本号与游戏版本的映射不同，
 * 官方版本接口在站点根路径的 `/api` 下。
 */

const KIND: LoaderSourceKind = 'neoforge'

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * NeoForge 的版本号映射到游戏版本：
 * - 21.1.x -> 1.21.1，21.0.x -> 1.21
 * - 47.x 是 1.20.1 的旧坐标
 * - 0.x 是快照构建，第二段就是游戏版本
 * - 26 之后改成独立版本号（26.1 / 26.1.2）
 */
export function neoforgeGameVersion(version: string): string | null {
  const core = version.split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null

  if (major === 0) return parts[1] ?? null
  if (major === 47) return '1.20.1'
  if (major >= 26) {
    const patch = parts[2]
    const base =
      patch !== undefined && Number(patch) === 0
        ? `${major}.${minor}`
        : `${major}.${minor}${patch ? `.${patch}` : ''}`
    const plus = version.indexOf('+')
    return plus >= 0 ? `${base}-${version.slice(plus + 1)}` : base
  }
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`
}

/** 1.20.1 的旧坐标带 `1.20.1-forge-` 前缀，统一成加载器版本号 */
function normalizeNeoForgeVersion(version: string): string {
  return version.replace(/^1\.20\.1-(?:forge-)?/, '')
}

/** NeoForge 官方版本接口（站点根路径下的 JSON） */
function parseOfficialNeoForgeVersions(value: unknown): string[] {
  const record = recordOf(value)
  const direct = Array.isArray(record?.versions) ? record.versions : []
  const versions = direct.filter((item): item is string => typeof item === 'string')
  if (versions.length > 0) return versions

  // 兼容 Nexus / maven-metadata 包装的形态
  const versioning = recordOf(record?.versioning)
  const nested = Array.isArray(versioning?.versions) ? versioning.versions : []
  return nested.filter((item): item is string => typeof item === 'string')
}

/** BMCLAPI 的 NeoForge 列表：每条带 version 与 mcversion */
function parseBmclNeoForgeVersions(value: unknown, gameVersion: string): string[] {
  if (!Array.isArray(value)) return []
  const versions: string[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (!record) continue
    const version = stringOf(record.version)
    const mcVersion = stringOf(record.mcversion)
    if (!version) continue
    if (mcVersion && mcVersion !== gameVersion) continue
    versions.push(version)
  }
  return versions
}

function defaultSources(): LoaderSource[] {
  return normalizeLoaderSources(
    DEFAULT_LOADER_SOURCES.filter((source) => source.kind === KIND).map((source) => ({ ...source }))
  )
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.loader.neoforge')

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

  /**
   * NeoForge 版本列表。
   *
   * 官方使用站点根路径下的 JSON 接口（maven-metadata.xml 并不一定存在），
   * BMCLAPI 则有专门的 `/neoforge/list/{game}` 接口；两者并行请求、结果合并，
   * 只镜像了 maven 文件的源再退回 maven-metadata.xml。
   */
  async function listVersions(gameVersion: string, signal: AbortSignal): Promise<LoaderVersion[]> {
    const legacy = gameVersion === '1.20.1'
    const requests: Array<Promise<string[]>> = []
    let hasFastSource = false

    for (const source of sources()) {
      if (!source.enabled) continue
      const origin = originOf(source.meta)
      if (!origin) continue

      if (isBmclHost(origin)) {
        hasFastSource = true
        requests.push(
          fetchJsonUrl<unknown>(
            `${origin}/neoforge/list/${encodeURIComponent(gameVersion)}`,
            signal
          ).then((value) => parseBmclNeoForgeVersions(value, gameVersion))
        )
        continue
      }

      const api = legacy
        ? '/api/maven/versions/releases/net/neoforged/forge'
        : '/api/maven/versions/releases/net/neoforged/neoforge'
      requests.push(
        fetchJsonUrl<unknown>(`${origin}${api}`, signal).then(parseOfficialNeoForgeVersions)
      )
    }

    // 有 BMCLAPI 速源时最多等 2.5 秒，官方接口慢也不会一直卡住
    let lists = hasFastSource ? await settleWithin(requests, 2500) : []
    if (lists.length === 0) {
      lists = (await Promise.allSettled(requests))
        .filter(
          (result): result is PromiseFulfilledResult<string[]> => result.status === 'fulfilled'
        )
        .map((result) => result.value)
    }

    const versions: string[] = lists.flat()
    if (versions.length === 0) {
      const xml = await fetchLoaderText(
        legacy
          ? '/net/neoforged/forge/maven-metadata.xml'
          : '/net/neoforged/neoforge/maven-metadata.xml',
        'maven',
        signal
      )
      versions.push(...parseMavenVersions(xml))
    }

    const seen = new Set<string>()
    const result: LoaderVersion[] = []
    for (const raw of versions) {
      const version = normalizeNeoForgeVersion(raw)
      if (!version || seen.has(version)) continue
      if (neoforgeGameVersion(version) !== gameVersion) continue
      seen.add(version)
      result.push({
        id: version,
        gameVersion,
        channel: isPrerelease(version) ? 'beta' : 'stable',
        date: ''
      })
    }
    return result.sort((a, b) => compareSegments(b.id, a.id))
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
  log.info('NeoForge 加载器已就绪（%d 个源）', sources().length)
}

export default defineMainPlugin({ name, inject, apply })
