import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import path from 'node:path'
import {
  isReadableZipBuffer,
  readZipEntries,
  zipEntryData,
  type ZipEntry,
} from '@mics/sdk/main'

// Zip 读取与结构校验是下载管线 / 启动插件共用的实现，放在 @mics/sdk/main。

export interface JarModInfo {
  /** mod id；用于在 Mod 目录里搜索对应项目 */
  id?: string
  /** 展示名称 */
  name?: string
  /** 内嵌图标，data URL；没有图标时为空 */
  icon?: string
  /** Modrinth 指纹 */
  sha1?: string
  /** CurseForge 指纹 */
  murmur2?: number
}

/**
 * CurseForge 使用的 MurmurHash2（seed 1）。
 *
 * 算法本身是公开规范；这里按字节流实现，空白字节 9/10/13/32 会被跳过，
 * 与外置 Mod 的 jar 内容无关，因此不依赖下载记录。
 */
function murmur2(buffer: Buffer): number {
  const filtered = Buffer.allocUnsafe(buffer.length)
  let length = 0
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32) continue
    filtered[length] = byte
    length += 1
  }

  const data = filtered.subarray(0, length)
  let h = (1 ^ length) >>> 0
  let i = 0
  while (length - i >= 4) {
    let k = data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)
    k = Math.imul(k, 0x5bd1e995)
    k ^= k >>> 24
    k = Math.imul(k, 0x5bd1e995)
    h = Math.imul(h, 0x5bd1e995) ^ k
    i += 4
  }

  const remaining = length - i
  if (remaining === 3) {
    h ^= data[i + 2]! << 16
    h ^= data[i + 1]! << 8
    h ^= data[i]!
    h = Math.imul(h, 0x5bd1e995)
  } else if (remaining === 2) {
    h ^= data[i + 1]! << 8
    h ^= data[i]!
    h = Math.imul(h, 0x5bd1e995)
  } else if (remaining === 1) {
    h ^= data[i]!
    h = Math.imul(h, 0x5bd1e995)
  }

  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return h >>> 0
}

const MOD_INFO_CACHE_LIMIT = 256
const MAX_ICON_BYTES = 512 * 1024
const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

const modInfoCache = new Map<string, { key: string; info: JarModInfo }>()

function imageMime(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return ICON_MIME[name.slice(dot).toLowerCase()]
}

function iconRank(name: string, modId?: string): number {
  const lower = name.toLowerCase()
  if (/^assets\/[^/]+\/icon\.(png|jpe?g|webp)$/i.test(name)) return 0
  if (modId && /^[^/]+\.(png|jpe?g|webp)$/i.test(name)) {
    const base = lower.slice(0, lower.lastIndexOf('.'))
    const id = modId.toLowerCase()
    // 不少模组把图标放在根目录，例如 sodium-icon.png
    if (base === `${id}-icon` || base === id) return 1
  }
  if (/^icon\.(png|jpe?g|webp)$/i.test(name)) return 2
  if (/^[^/]*(?:^|[-_])icon\.(png|jpe?g|webp)$/i.test(name)) return 3
  if (/^[^/]*(?:logo|pack)\.(png|jpe?g|webp)$/i.test(name)) return 4
  if (/(^|\/)(icon|logo|pack)[^/]*\.(png|jpe?g|webp)$/i.test(name)) return 5
  return 99
}

function metadataOf(entries: ZipEntry[], buffer: Buffer): { id?: string; name?: string } {
  const readJson = (entry: ZipEntry | undefined): Record<string, unknown> | null => {
    if (!entry) return null
    const data = zipEntryData(buffer, entry)
    if (!data) return null
    try {
      return JSON.parse(data.toString('utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const fabric = readJson(entries.find((entry) => entry.name === 'fabric.mod.json'))
  if (fabric) {
    return {
      id: typeof fabric.id === 'string' ? fabric.id : undefined,
      name: typeof fabric.name === 'string' ? fabric.name : undefined,
    }
  }

  const quilt = readJson(entries.find((entry) => entry.name === 'quilt.mod.json'))
  if (quilt) {
    const loader = quilt.quilt_loader as Record<string, unknown> | undefined
    const metadata = quilt.metadata as Record<string, unknown> | undefined
    return {
      id: typeof loader?.id === 'string' ? loader.id : undefined,
      name: typeof metadata?.name === 'string' ? metadata.name : undefined,
    }
  }

  const tomlEntry = entries.find(
    (entry) => entry.name === 'META-INF/mods.toml' || entry.name === 'META-INF/neoforge.mods.toml',
  )
  if (tomlEntry) {
    const data = zipEntryData(buffer, tomlEntry)
    if (data) {
      const text = data.toString('utf8')
      const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
      const name = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
      if (id || name) return { id, name }
    }
  }

  return {}
}

/**
 * 读取 Mod jar 的基本信息：mod id / 名称 / 内嵌图标。
 *
 * 实例 Mod 列表用它显示图标并支持「点击跳到 Mod 目录详情」；读取失败或没有
 * 图标时返回空信息，界面会保留一个同样大小的空位。
 */
export function readJarModInfo(file: string): JarModInfo {
  let info: Stats
  try {
    info = statSync(file)
  } catch {
    return {}
  }

  const cacheKey = `${info.size}:${info.mtimeMs}`
  const cached = modInfoCache.get(file)
  if (cached?.key === cacheKey) return cached.info

  let result: JarModInfo = {}
  try {
    const buffer = readFileSync(file)
    const entries = readZipEntries(buffer)
    const metadata = metadataOf(entries, buffer)
    const sha1 = createHash('sha1').update(buffer).digest('hex')
    const fingerprint = murmur2(buffer)

    let icon: string | undefined
    const candidates = entries
      .filter((entry) => imageMime(entry.name) !== undefined)
      .map((entry) => ({ entry, rank: iconRank(entry.name, metadata.id) }))
      .filter((item) => item.rank < 99 && item.entry.uncompressedSize <= MAX_ICON_BYTES)
      .sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length)

    const chosen = candidates[0]?.entry
    if (chosen) {
      const data = zipEntryData(buffer, chosen)
      const mime = imageMime(chosen.name)
      if (data && mime) icon = `data:${mime};base64,${data.toString('base64')}`
    }

    result = { ...metadata, sha1, murmur2: fingerprint, ...(icon ? { icon } : {}) }
  } catch {
    result = {}
  }

  if (modInfoCache.size >= MOD_INFO_CACHE_LIMIT) {
    const oldest = modInfoCache.keys().next().value
    if (oldest !== undefined) modInfoCache.delete(oldest)
  }
  modInfoCache.set(file, { key: cacheKey, info: result })
  return result
}

const NATIVE_PATTERN = /\.(dll|so|dylib|jnilib)$/i

/**
 * 检查 jar 是否能被 JVM 正常读取。
 *
 * 只看文件头不够：下载中断后重试时，服务端忽略 Range 可能把完整文件追加到
 * 残缺的 `.part` 后面，得到的文件仍然以 `PK` 开头，但中央目录偏移全部错位，
 * JVM 会报 ClassNotFoundException。这里对齐 EOCD、中央目录与首个本地头。
 */
export function isReadableJar(file: string): boolean {
  try {
    return isReadableZipBuffer(readFileSync(file))
  } catch {
    return false
  }
}

export interface NativeSyncResult {
  /** 本次同步后期望存在的 DLL 绝对路径，供调用方清理多余文件 */
  files: string[]
  /** 是否有文件因为被运行中的进程占用而跳过更新 */
  locked: boolean
}

/** Windows 上被运行中的进程映射的 DLL 在删除/覆盖时会报这些错误码 */
function isLockedFileError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * 把 native jar 里的动态库同步到目标目录，复用已有的同名文件。
 *
 * 与「先清空再解压」不同：
 * - 目标文件已存在且大小与 jar 内条目一致 → 直接跳过，不读不写；
 * - 大小不一致 → 先删后写；删除时报 EPERM/EBUSY，说明有实例正锁着 DLL，
 *   本次跳过更新并沿用现有文件（调用方据此记日志）。
 *
 * 不整目录删除，因此「仍要启动」不会再因为运行中的实例而失败。
 */
export function syncNativeLibraries(jarPath: string, destDir: string): NativeSyncResult {
  const buffer = readFileSync(jarPath)
  const entries = readZipEntries(buffer)
  mkdirSync(destDir, { recursive: true })

  const files: string[] = []
  let locked = false

  for (const entry of entries) {
    if (!NATIVE_PATTERN.test(entry.name) || entry.name.startsWith('META-INF/')) continue

    const target = path.join(destDir, path.basename(entry.name))
    files.push(target)

    let existing: Stats | null = null
    try {
      existing = statSync(target)
    } catch {
      existing = null
    }

    if (existing?.isFile() && existing.size === entry.uncompressedSize) continue

    if (existing) {
      try {
        unlinkSync(target)
      } catch (cause) {
        if (isLockedFileError(cause)) {
          locked = true
          continue
        }
        throw cause
      }
    }

    const data = zipEntryData(buffer, entry)
    if (data) writeFileSync(target, data)
  }

  return { files, locked }
}
