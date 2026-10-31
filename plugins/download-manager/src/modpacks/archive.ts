import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  extractZipEntries,
  readZipTextFromBuffer,
  safeZipEntryPath,
} from '@mics/sdk/main'
import type { LoaderKind, ModLoader } from '@mics/sdk'

/**
 * 整合包归档解析。
 *
 * 目前支持两种事实标准：
 * - Modrinth `.mrpack`：`modrinth.index.json` + `overrides/` / `client-overrides/`；
 * - CurseForge `.zip`：`manifest.json` + `overrides/`。
 *
 * 解析只负责「归档里写了什么」，真正下载原版 / 加载器 / 包内文件由下载管线
 * 统一处理；这样两种格式不会各自复制一套安装流程。
 */

export interface ModpackDirectFile {
  /** 相对实例根目录的路径，例如 mods/sodium.jar */
  path: string
  url: string
  sha1: string
  size: number
}

export interface ModpackCurseforgeFile {
  projectId: number
  fileId: number
  /** 清单标记为必需；可选文件缺失时不阻断安装 */
  required: boolean
}

export type ModpackFileEntry =
  | ({ kind: 'direct' } & ModpackDirectFile)
  | ({ kind: 'curseforge' } & ModpackCurseforgeFile)

export interface ParsedModpack {
  format: 'modrinth' | 'curseforge'
  name: string
  version: string
  gameVersion: string
  /** 归档声明的加载器；没有加载器表示原版整合包 */
  loader?: { kind: string; version: string }
  /** 归档要求但当前管线不支持的加载器（例如 Quilt） */
  unsupportedLoader?: string
  files: ModpackFileEntry[]
  /** 覆盖文件在归档里的前缀，例如 `overrides/` */
  overridePrefixes: string[]
}

const SUPPORTED_LOADERS = new Set<LoaderKind>(['fabric', 'forge', 'neoforge'])

/** Modrinth 依赖键 -> 加载器类型 */
const MODRINTH_LOADER_KEYS: ReadonlyArray<[string, ModLoader]> = [
  ['fabric-loader', 'fabric'],
  ['forge', 'forge'],
  ['neoforge', 'neoforge'],
  ['quilt-loader', 'quilt'],
]

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOf(value: unknown): number {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function readJson(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    const record = recordOf(value)
    if (!record) throw new Error('顶层不是对象')
    return record
  } catch (cause) {
    throw new Error(`${label} 不是有效的 JSON：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** 加载器类型归一化；Quilt 会被单独标记，由调用方给出清晰提示 */
function loaderOf(kind: string, version: string): { kind: string; version: string } | undefined {
  const normalized = kind.trim().toLowerCase()
  if (!normalized || normalized === 'vanilla') return undefined
  return { kind: normalized, version: version.trim() }
}

function unsupportedLoaderOf(loader: { kind: string; version: string } | undefined): string | undefined {
  if (!loader || SUPPORTED_LOADERS.has(loader.kind as LoaderKind)) return undefined
  return loader.kind
}

/** 从 CurseForge 的 `modLoaders[].id`（例如 `forge-47.2.0`）解析类型与版本 */
function parseCurseforgeLoader(id: string): { kind: string; version: string } | undefined {
  const trimmed = id.trim()
  if (!trimmed || trimmed.toLowerCase() === 'vanilla') return undefined
  const dash = trimmed.indexOf('-')
  if (dash <= 0) return undefined
  return {
    kind: trimmed.slice(0, dash),
    version: trimmed.slice(dash + 1),
  }
}

function parseModrinthIndex(record: Record<string, unknown>): ParsedModpack {
  const dependencies = recordOf(record.dependencies)
  const gameVersion = stringOf(dependencies?.minecraft)
  if (!gameVersion) throw new Error('整合包没有声明游戏版本（dependencies.minecraft）')

  let loader: { kind: string; version: string } | undefined
  for (const [key, kind] of MODRINTH_LOADER_KEYS) {
    const version = stringOf(dependencies?.[key])
    if (!version) continue
    loader = { kind, version }
    break
  }

  const files: ModpackFileEntry[] = []
  const rawFiles = Array.isArray(record.files) ? record.files : []
  for (const raw of rawFiles) {
    const file = recordOf(raw)
    if (!file) continue
    const env = recordOf(file.env)
    // 仅服务端文件在客户端实例里没有意义
    if (env && stringOf(env.client) === 'unsupported') continue

    const filePath = safeZipEntryPath(stringOf(file.path))
    const downloads = Array.isArray(file.downloads) ? file.downloads : []
    const url = downloads
      .map((item) => stringOf(item))
      .find((item) => /^https?:\/\//i.test(item))
    if (!filePath || !url) {
      throw new Error(`整合包文件缺少路径或下载地址：${stringOf(file.path) || '未知文件'}`)
    }

    const hashes = recordOf(file.hashes)
    files.push({
      kind: 'direct',
      path: filePath,
      url,
      sha1: stringOf(hashes?.sha1).toLowerCase(),
      size: numberOf(file.fileSize),
    })
  }

  return {
    format: 'modrinth',
    name: stringOf(record.name) || '整合包',
    version: stringOf(record.versionId),
    gameVersion,
    ...(loader ? { loader } : {}),
    ...(unsupportedLoaderOf(loader)
      ? { unsupportedLoader: unsupportedLoaderOf(loader) }
      : {}),
    files,
    overridePrefixes: ['overrides/', 'client-overrides/'],
  }
}

function parseCurseforgeManifest(record: Record<string, unknown>): ParsedModpack {
  const manifestType = stringOf(record.manifestType)
  if (manifestType && manifestType !== 'minecraftModpack') {
    throw new Error(`不支持的整合包清单类型：${manifestType}`)
  }

  const minecraft = recordOf(record.minecraft)
  const gameVersion = stringOf(minecraft?.version)
  if (!gameVersion) throw new Error('整合包没有声明游戏版本（minecraft.version）')

  const rawLoaders = Array.isArray(minecraft?.modLoaders) ? minecraft.modLoaders : []
  const loaderEntries = rawLoaders
    .map(recordOf)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
  const primary = loaderEntries.find((entry) => entry.primary === true) ?? loaderEntries[0]
  const parsedLoader = primary ? parseCurseforgeLoader(stringOf(primary.id)) : undefined
  const loader = parsedLoader
    ? loaderOf(parsedLoader.kind, parsedLoader.version)
    : undefined

  const files: ModpackFileEntry[] = []
  const rawFiles = Array.isArray(record.files) ? record.files : []
  for (const raw of rawFiles) {
    const file = recordOf(raw)
    if (!file) continue
    const projectId = numberOf(file.projectID)
    const fileId = numberOf(file.fileID)
    if (!projectId || !fileId) continue
    files.push({ kind: 'curseforge', projectId, fileId, required: file.required !== false })
  }

  const overrides = stringOf(record.overrides) || 'overrides'
  const safeOverrides = safeZipEntryPath(overrides)
  if (!safeOverrides) throw new Error('整合包覆盖目录路径无效')

  return {
    format: 'curseforge',
    name: stringOf(record.name) || '整合包',
    version: stringOf(record.version),
    gameVersion,
    ...(loader ? { loader } : {}),
    ...(unsupportedLoaderOf(loader)
      ? { unsupportedLoader: unsupportedLoaderOf(loader) }
      : {}),
    files,
    overridePrefixes: [`${safeOverrides}/`],
  }
}

/** 读取归档里的清单；无法识别时抛出可读错误 */
export async function parseModpackArchive(archive: string): Promise<ParsedModpack> {
  // 两种格式的清单文件名不同，但只需要读一次归档
  const buffer = await readFile(archive)
  const indexText = readZipTextFromBuffer(buffer, 'modrinth.index.json')
  if (indexText) return parseModrinthIndex(readJson(indexText, 'modrinth.index.json'))

  const manifestText = readZipTextFromBuffer(buffer, 'manifest.json')
  if (manifestText) return parseCurseforgeManifest(readJson(manifestText, 'manifest.json'))

  throw new Error('无法识别的整合包格式：缺少 modrinth.index.json 或 manifest.json')
}

/** 把覆盖文件解压到暂存目录；完成安装时再合并进实例 */
export async function extractModpackOverrides(
  archive: string,
  prefixes: string[],
  dest: string,
): Promise<number> {
  const normalized = prefixes
    .map((prefix) => prefix.replace(/\\/g, '/'))
    .map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`))
    .filter(Boolean)
  if (normalized.length === 0) return 0

  const result = await extractZipEntries(archive, dest, {
    map: (_entry, relative) => {
      const prefix = normalized.find((item) => relative.startsWith(item))
      if (!prefix) return null
      const stripped = relative.slice(prefix.length)
      return stripped || null
    },
  })
  return result.files
}

/** 整合包归档缓存文件名：优先按摘要，其次按地址散列 */
export function modpackArchiveName(sha1: string, url: string, fileName: string): string {
  const extension = path.extname(fileName).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.zip'
  if (/^[0-9a-f]{40}$/.test(sha1)) return `${sha1}${safeExtension}`
  const key = Buffer.from(url).toString('base64url').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  return `${key || 'modpack'}${safeExtension}`
}
