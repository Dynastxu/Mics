import https from 'node:https'
import http from 'node:http'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import type { GameVersion } from '@mics/sdk'

/**
 * Mojang 官方版本清单
 * @see https://launchermeta.mojang.com/mc/game/version_manifest.json
 */
const MOJANG_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json'

interface MojangManifestVersion {
  id: string
  type: string
  releaseTime: string
  url: string
}

interface MojangManifest {
  latest: { release: string; snapshot: string }
  versions: MojangManifestVersion[]
}

interface MojangVersionDetail {
  downloads: {
    client?: { url: string; sha1: string; size: number }
    server?: { url: string; sha1: string; size: number }
  }
  libraries: Array<{
    name: string
    downloads: {
      artifact?: { url: string; sha1: string; size: number }
    }
  }>
  assetIndex: { url: string; sha1: string; size: number }
  assets: string
}

/** 类型映射：Mojang type -> 中文类型 */
const MOJANG_TYPE_MAP: Record<string, GameVersion['type']> = {
  release: 'release',
  snapshot: 'snapshot',
  old_alpha: 'old_alpha',
  old_beta: 'old_beta',
}

function mapType(mojangType: string): GameVersion['type'] {
  return MOJANG_TYPE_MAP[mojangType] ?? 'snapshot'
}

function safeFetch(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`))
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (err) { reject(err) }
      })
    }).on('error', reject)
  })
}

export const name = 'mics.download.vanilla'
export const inject = ['ipc']

export function apply(ctx: Context): void {
  let cachedManifest: MojangManifest | null = null
  let cachedAt = 0
  const CACHE_TTL = 5 * 60 * 1000

  async function fetchManifest(): Promise<MojangManifest> {
    if (cachedManifest && Date.now() - cachedAt < CACHE_TTL) {
      return cachedManifest
    }
    const data = await safeFetch(MOJANG_MANIFEST_URL)
    cachedManifest = data as MojangManifest
    cachedAt = Date.now()
    return cachedManifest
  }

  /** 获取版本列表 */
  ctx.ipc.handle('versions/list', async () => {
    const manifest = await fetchManifest()
    const versions: GameVersion[] = manifest.versions.map((v) => ({
      id: v.id,
      type: mapType(v.type),
      releaseTime: v.releaseTime,
      url: v.url,
    }))
    return versions
  })

  /** 获取特定版本的详细信息（含下载链接） */
  ctx.ipc.handle<{ version: string }>('versions/detail', async ({ version }) => {
    const manifest = await fetchManifest()
    const entry = manifest.versions.find((v) => v.id === version)
    if (!entry) throw new Error(`未找到版本 ${version}`)
    const detail = await safeFetch(entry.url)
    const d = detail as MojangVersionDetail

    return {
      downloads: {
        client: d.downloads?.client
          ? { url: d.downloads.client.url, sha1: d.downloads.client.sha1, size: d.downloads.client.size }
          : undefined,
        server: d.downloads?.server
          ? { url: d.downloads.server.url, sha1: d.downloads.server.sha1, size: d.downloads.server.size }
          : undefined,
      },
      libraries: (d.libraries ?? []).map((lib) => ({
        name: lib.name,
        downloads: {
          artifact: lib.downloads?.artifact
            ? { url: lib.downloads.artifact.url, sha1: lib.downloads.artifact.sha1 ?? '', size: lib.downloads.artifact.size ?? 0 }
            : undefined,
        },
      })),
      assetIndex: d.assetIndex
        ? { url: d.assetIndex.url, sha1: d.assetIndex.sha1, size: d.assetIndex.size }
        : undefined,
      assets: d.assets ?? 'legacy',
    }
  })
}

export default defineMainPlugin({ name, inject, apply })