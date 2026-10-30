import { LOADER_LABELS, LOADER_SOURCE_KINDS } from '@mics/sdk'
import type { LoaderSource, LoaderSourceKind } from '@mics/sdk'

/**
 * 加载器下载地址的解析规则。
 *
 * 下载源里保存的是「主机名 + 可选路径前缀」，和原版下载源保持一致：
 * 官方地址是内置常量，镜像只要提供同构的元数据 / maven 路径即可复用。
 */

/** 各家加载器的官方地址（元数据与文件） */
export const OFFICIAL_LOADER_BASES: Record<LoaderSourceKind, { meta: string; maven: string }> = {
  fabric: { meta: 'meta.fabricmc.net', maven: 'maven.fabricmc.net' },
  forge: {
    meta: 'files.minecraftforge.net',
    maven: 'maven.minecraftforge.net',
  },
  neoforge: {
    // 版本接口在站点根路径 /api 下；文件仍在 /releases
    meta: 'maven.neoforged.net',
    maven: 'maven.neoforged.net/releases',
  },
}

export interface LoaderUrlMatch {
  kind: LoaderSourceKind
  /** 命中元数据还是文件地址 */
  role: 'meta' | 'maven'
  /** 基址之后的路径：空串或以 `/` 开头 */
  suffix: string
}

/** 去掉协议与结尾斜杠，得到可直接比较的「主机 + 路径」 */
export function stripScheme(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '')
}

/** 把下载源里的基址补全成绝对地址；基址为空时返回空串 */
export function absoluteUrl(base: string, suffix: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!suffix) return withScheme
  return `${withScheme}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

/** 只保留协议与主机：用于拼接站点根路径下的接口（例如 NeoForge 的 /api） */
export function originOf(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return ''
  }
}

/**
 * 判断一个地址属于哪个加载器的元数据 / 文件仓库。
 *
 * 同时匹配内置官方地址与用户配置的镜像地址：这样镜像返回的绝对地址
 * 也能被其它源替换。最长前缀优先，避免 `/releases` 被更短的基址抢走。
 */
export function matchLoaderUrl(
  url: string,
  sources: LoaderSource[],
): LoaderUrlMatch | null {
  const bare = stripScheme(url)
  if (!bare) return null

  const endpoints: Array<{ kind: LoaderSourceKind; role: 'meta' | 'maven'; base: string }> = []
  for (const kind of LOADER_SOURCE_KINDS) {
    endpoints.push({ kind, role: 'maven', base: OFFICIAL_LOADER_BASES[kind].maven })
    endpoints.push({ kind, role: 'meta', base: OFFICIAL_LOADER_BASES[kind].meta })
  }
  for (const source of sources) {
    endpoints.push({ kind: source.kind, role: 'maven', base: source.maven })
    endpoints.push({ kind: source.kind, role: 'meta', base: source.meta })
  }

  let matched: LoaderUrlMatch | null = null
  let matchedLength = -1
  for (const endpoint of endpoints) {
    const host = stripScheme(endpoint.base)
    if (!host || host.length <= matchedLength) continue
    if (bare !== host && !bare.startsWith(`${host}/`)) continue
    matched = { kind: endpoint.kind, role: endpoint.role, suffix: bare.slice(host.length) }
    matchedLength = host.length
  }
  return matched
}

/** 指定加载器、参与下载的源（保持优先级顺序） */
export function enabledSourcesOf(
  sources: LoaderSource[],
  kind: LoaderSourceKind,
): LoaderSource[] {
  return sources.filter((source) => source.kind === kind && source.enabled)
}

/** 按优先级把所有参与下载的源展开成绝对地址（去重） */
export function metadataCandidates(
  sources: LoaderSource[],
  kind: LoaderSourceKind,
  path: string,
  role: 'meta' | 'maven' = 'meta',
): string[] {
  const urls: string[] = []
  for (const source of enabledSourcesOf(sources, kind)) {
    const base = role === 'meta' ? source.meta : source.maven
    const url = absoluteUrl(base, path)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

/** 显示名：没有自定义名称时退回加载器官方名 */
export function sourceLabel(source: LoaderSource, index: number): string {
  const label = source.label.trim()
  if (label) return label
  return `${LOADER_LABELS[source.kind]} 源 ${index + 1}`
}
