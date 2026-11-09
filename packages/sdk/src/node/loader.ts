import { createHash } from 'node:crypto'
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { LOADER_LABELS, LOADER_SOURCE_KINDS } from '../contract/download'
import type { LoaderSource, LoaderSourceKind, LoaderVersion } from '../contract/download'
import type { DownloadEndpoint } from '../contract/download-pipeline'
import type { LoaderPrepareInput, LoaderPrepareResult, LoaderRuntime } from '../contract/loader'
import type { VersionDetail } from '../contract/minecraft'
import { instanceClientJar, instanceVersionJson } from './layout'
import { mavenPath } from './minecraft'

/**
 * 加载器安装的共享实现。
 *
 * 每个加载器插件仍然独立拥有版本列表、镜像配置与安装入口；这里只放三种
 * 加载器都会用到的机械工作：镜像地址解析、文件搬运、安装器依赖预取与
 * 「安装器跑在暂存目录、产物搬进实例」的通用流程。
 */

/** 各家加载器的官方地址（元数据与文件） */
export const OFFICIAL_LOADER_BASES: Record<LoaderSourceKind, { meta: string; maven: string }> = {
  fabric: { meta: 'meta.fabricmc.net', maven: 'maven.fabricmc.net' },
  forge: {
    meta: 'files.minecraftforge.net',
    maven: 'maven.minecraftforge.net'
  },
  neoforge: {
    // 版本接口在站点根路径 /api 下；文件仍在 /releases
    meta: 'maven.neoforged.net',
    maven: 'maven.neoforged.net/releases'
  }
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
export function matchLoaderUrl(url: string, sources: LoaderSource[]): LoaderUrlMatch | null {
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
export function enabledSourcesOf(sources: LoaderSource[], kind: LoaderSourceKind): LoaderSource[] {
  return sources.filter((source) => source.kind === kind && source.enabled)
}

/** 按优先级把所有参与下载的源展开成绝对地址（去重） */
export function metadataCandidates(
  sources: LoaderSource[],
  kind: LoaderSourceKind,
  path: string,
  role: 'meta' | 'maven' = 'meta'
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

/**
 * 加载器地址 -> 该加载器配置的候选源。
 *
 * 不是加载器地址时返回空数组，调用方继续用原版源。用于把版本档案里的
 * 官方 maven 库地址换成镜像，避免加载器库绕过镜像直连官方。
 */
export function loaderEndpointsFor(url: string, sources: LoaderSource[]): DownloadEndpoint[] {
  const match = matchLoaderUrl(url, sources)
  if (!match) return []

  const endpoints: DownloadEndpoint[] = []
  const seen = new Set<string>()
  for (const [index, source] of sources.entries()) {
    if (!source.enabled || source.kind !== match.kind) continue
    const base = match.role === 'maven' ? source.maven : source.meta
    const candidate = absoluteUrl(base, match.suffix)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    endpoints.push({
      id: `loader:${source.kind}:${index}`,
      label: sourceLabel(source, index),
      url: candidate,
      category: match.role === 'meta' ? 'meta' : 'loader'
    })
  }
  return endpoints
}

// ---------------------------------------------------------------------------
// 文件搬运
// ---------------------------------------------------------------------------

/**
 * 把 `source` 目录的内容合并进 `target`。
 *
 * 默认同名文件由 `source` 覆盖；`overwrite: false` 时保留 `target` 里已有的文件，
 * 用于并入共享库目录——那里可能有别的实例正在用的同名文件，覆盖会截断正在被
 * 另一个进程读取的 jar。结束后删除 `source`（含空目录）。
 */
export async function moveTreeInto(
  source: string,
  target: string,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch {
    return
  }

  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)

    if (entry.isDirectory()) {
      await moveTreeInto(from, to, options)
      await rm(from, { recursive: true, force: true })
      continue
    }

    await mkdir(path.dirname(to), { recursive: true })
    if (options.overwrite === false && existsSync(to)) {
      await rm(from, { force: true })
      continue
    }
    await rm(to, { force: true }).catch(() => undefined)
    try {
      await rename(from, to)
    } catch {
      await copyFile(from, to)
      await rm(from, { force: true })
    }
  }

  await rm(source, { recursive: true, force: true }).catch(() => undefined)
}

/** 读取日志末尾；安装器失败时把它附在错误信息里，避免只剩一个退出码 */
export async function tailText(file: string, limit = 1200): Promise<string> {
  try {
    const text = await readFile(file, 'utf8')
    const trimmed = text.trim()
    return trimmed.length > limit ? trimmed.slice(-limit) : trimmed
  } catch {
    return ''
  }
}

/**
 * 读取文件末尾最后一行非空内容（安装器日志用）。
 *
 * 只读末尾几 KB，日志涨到几 MB 也不会每次全量读取；安装器没有进度接口，
 * 界面靠这一行知道它正在下载哪个库 / 跑哪个处理器。
 */
export async function tailLastLine(file: string, maxBytes = 4096): Promise<string> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return ''
  }

  try {
    const info = await handle.stat()
    const length = Math.min(info.size, maxBytes)
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, info.size - length)
    const lines = buffer.toString('utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = (lines[index] ?? '').trim()
      if (!line) continue
      return line.length > 160 ? `${line.slice(0, 157)}…` : line
    }
    return ''
  } catch {
    return ''
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// jar 内条目（安装器清单）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT = 0xffff

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

function readEntries(buffer: Buffer): ZipEntry[] {
  let eocd = -1
  const start = Math.max(0, buffer.length - MAX_COMMENT - 22)
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 Zip 文件')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function entryData(buffer: Buffer, entry: ZipEntry): Buffer | null {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) return null
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return data
  if (entry.method === 8) {
    try {
      return inflateRawSync(data)
    } catch {
      return null
    }
  }
  return null
}

/** 读取 jar 内的文本条目；文件、条目或压缩格式不支持时返回 null */
export function readZipTextEntry(jarPath: string, entryName: string): string | null {
  let buffer: Buffer
  try {
    buffer = readFileSync(jarPath)
  } catch {
    return null
  }

  let entry: ZipEntry | undefined
  try {
    entry = readEntries(buffer).find((candidate) => candidate.name === entryName)
  } catch {
    return null
  }
  if (!entry) return null

  const data = entryData(buffer, entry)
  return data ? data.toString('utf8') : null
}

// ---------------------------------------------------------------------------
// 安装器依赖预取
// ---------------------------------------------------------------------------

interface InstallerLibrary {
  name: string
  /** maven 相对路径 */
  path: string
  url: string
  sha1: string
  size: number
}

export interface InstallerPrefetchOptions {
  /** 安装器的 libraries 目录（`<installClient>/libraries`） */
  librariesDir: string
  /** 共享库目录；已有同内容文件时直接硬链接，不再下载 */
  sharedLibrariesDir: string
  /** 展示名，例如 Forge；用于阶段说明 */
  label?: string
  download: (url: string, target: string, sha1?: string, size?: number) => Promise<void>
  report?: (note: string, percent?: number) => void
  log: (level: 'info' | 'warn', message: string) => void
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把 install_profile.json / version.json 的 libraries 展开成可下载的条目 */
function parseLibraries(text: string | null, kind: LoaderSourceKind): InstallerLibrary[] {
  if (!text) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const record = recordOf(parsed)
  // 1.13+：install_profile 顶层 libraries 是安装器/处理器依赖；
  // 更老的安装器把版本信息塞在 install_profile.versionInfo 里。
  const lists = [record?.libraries, recordOf(record?.versionInfo)?.libraries].filter(
    Array.isArray
  ) as unknown[][]

  const base = OFFICIAL_LOADER_BASES[kind].maven
  const libraries: InstallerLibrary[] = []

  for (const list of lists) {
    for (const value of list) {
      const entry = recordOf(value)
      const name = stringOf(entry?.name)
      if (!name) continue
      // 只给服务端用的库不必取
      if (entry?.clientreq === false) continue

      const artifact = recordOf(recordOf(entry?.downloads)?.artifact)
      const relative = stringOf(artifact?.path) || mavenPath(name)
      if (!relative) continue

      const url = stringOf(artifact?.url) || absoluteUrl(base, relative)
      if (!url) continue

      libraries.push({
        name,
        path: relative,
        url,
        sha1: stringOf(artifact?.sha1),
        size: numberOf(artifact?.size)
      })
    }
  }

  return libraries
}

/** 合并多份清单：同一路径只留一份，优先保留带摘要的条目 */
function mergeInstallerLibraries(lists: InstallerLibrary[][]): InstallerLibrary[] {
  const byPath = new Map<string, InstallerLibrary>()
  for (const list of lists) {
    for (const library of list) {
      const existing = byPath.get(library.path)
      if (!existing) {
        byPath.set(library.path, library)
        continue
      }
      if (!existing.sha1 && library.sha1) byPath.set(library.path, library)
    }
  }
  return [...byPath.values()]
}

async function sha1Of(file: string): Promise<string | null> {
  try {
    return createHash('sha1')
      .update(await readFile(file))
      .digest('hex')
  } catch {
    return null
  }
}

/** 共享库目录里已有同内容文件时，硬链接到安装器目录，省掉一次下载 */
async function reuseFromShared(
  spec: InstallerLibrary,
  target: string,
  sharedRoot: string
): Promise<boolean> {
  const source = path.join(sharedRoot, spec.path)
  try {
    const info = await stat(source)
    if (!info.isFile()) return false
    if (spec.size > 0 && info.size !== spec.size) return false
    if (spec.sha1 && (await sha1Of(source)) !== spec.sha1) return false
  } catch {
    return false
  }

  try {
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await link(source, target)
    } catch {
      // 跨卷或文件系统不支持硬链接
      await copyFile(source, target)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 固定并发跑完一组任务。
 *
 * 任何一个失败就停止派发新任务，但**等在途任务结束**再抛出：安装器马上要跑，
 * 不能让后台下载继续往它的 libraries 目录里写。
 */
async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  let failure: unknown = null

  const run = async (): Promise<void> => {
    while (failure === null) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      try {
        await worker(item)
      } catch (cause) {
        failure ??= cause
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  if (failure !== null) throw failure
}

export async function prefetchInstallerLibraries(
  installerPath: string,
  kind: LoaderSourceKind,
  options: InstallerPrefetchOptions
): Promise<void> {
  const libraries = mergeInstallerLibraries([
    parseLibraries(readZipTextEntry(installerPath, 'install_profile.json'), kind),
    // 安装器自己也会逐个下载 version.json 里的运行库（日志里的 "Considering library"）
    parseLibraries(readZipTextEntry(installerPath, 'version.json'), kind)
  ])
  if (libraries.length === 0) return

  let done = 0
  const total = libraries.length
  const label = options.label ?? '加载器'
  const tick = (): void => {
    done += 1
    options.report?.(`下载${label}支持库 ${done}/${total}`, (done / total) * 100)
  }

  options.report?.(`下载${label}支持库 0/${total}`, 0)
  await eachLimit(libraries, 6, async (library) => {
    const target = path.join(options.librariesDir, library.path)
    if (await reuseFromShared(library, target, options.sharedLibrariesDir)) {
      tick()
      return
    }
    await options.download(library.url, target, library.sha1, library.size)
    tick()
  })

  options.log('info', `安装器依赖库已就绪：${total} 个`)
}

// ---------------------------------------------------------------------------
// 安装器流程
// ---------------------------------------------------------------------------

/** 安装器只认「类 .minecraft」的目标目录，实例内的暂存目录名 */
const STAGING_DIR = '.installer'
/** 安装器 jar 与日志的暂存目录名 */
const WORK_DIR = '.loader'

/** 移动单个文件，目标已存在时覆盖；跨卷时退回复制 */
async function moveFile(from: string, to: string): Promise<void> {
  await rm(to, { force: true }).catch(() => undefined)
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

function readVersionJson(file: string): Promise<VersionDetail | null> {
  return readFile(file, 'utf8')
    .then((text) => {
      const value = JSON.parse(text) as unknown
      const record = recordOf(value)
      return typeof record?.id === 'string' && record.id ? (value as VersionDetail) : null
    })
    .catch(() => null)
}

/**
 * 找到安装器在暂存目录里生成的版本目录。
 *
 * 暂存目录是新建的，版本目录里除了原版只剩安装器写出的那一个；
 * 仍逐个校验版本文件，避免把残留目录当成结果。
 */
async function findInstalledVersion(
  stagingDir: string,
  gameVersion: string
): Promise<{ id: string; version: VersionDetail }> {
  const versionsDir = path.join(stagingDir, 'versions')
  let entries: Dirent[]
  try {
    entries = await readdir(versionsDir, { withFileTypes: true })
  } catch {
    entries = []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === gameVersion) continue
    const version = await readVersionJson(path.join(versionsDir, entry.name, `${entry.name}.json`))
    if (!version) continue
    return { id: entry.name, version }
  }

  throw new Error('安装器没有生成版本文件，请检查 Java 版本与安装器日志')
}

/**
 * 把安装器产物搬进实例：版本档案与客户端 jar 平铺到实例根，库并入共享库目录。
 *
 * 库不留在实例里：安装器按 `--installClient` 的约定把库写在自己的 `libraries/`，
 * 那是原版 `.minecraft/libraries` 的位置；本项目的共享层在用户数据根，并入后
 * 暂存目录整体删除，同一批 jar 不会存两处。
 */
async function promoteInstallerOutput(
  instanceDir: string,
  versionId: string,
  gameVersion: string,
  stagingDir: string,
  librariesDir: string
): Promise<void> {
  const installedDir = path.join(stagingDir, 'versions', versionId)
  const versionJson = path.join(installedDir, `${versionId}.json`)
  if (!existsSync(versionJson)) {
    throw new Error('安装器没有生成版本文件，请检查 Java 版本与安装器日志')
  }
  await mkdir(instanceDir, { recursive: true })
  await moveFile(versionJson, instanceVersionJson(instanceDir, versionId))

  // 客户端 jar：安装器自己产出过就用它的，否则用为安装器准备的原版 jar
  const targetJar = instanceClientJar(instanceDir, versionId)
  for (const candidate of [
    path.join(installedDir, `${versionId}.jar`),
    path.join(stagingDir, 'versions', gameVersion, `${gameVersion}.jar`)
  ]) {
    if (!existsSync(candidate)) continue
    await moveFile(candidate, targetJar)
    break
  }

  await moveTreeInto(path.join(stagingDir, 'libraries'), librariesDir, { overwrite: false })
  await rm(stagingDir, { recursive: true, force: true })
  await rm(path.join(instanceDir, WORK_DIR), { recursive: true, force: true })
}

function installerUrl(kind: LoaderSourceKind, gameVersion: string, loaderVersion: string): string {
  if (kind === 'forge') {
    const relative =
      `/net/minecraftforge/forge/${gameVersion}-${loaderVersion}` +
      `/forge-${gameVersion}-${loaderVersion}-installer.jar`
    return absoluteUrl(OFFICIAL_LOADER_BASES.forge.maven, relative)
  }
  // NeoForge 1.20.1 沿用了 Forge 的 net.neoforged:forge 坐标
  if (gameVersion === '1.20.1' && loaderVersion.startsWith('47.')) {
    const relative =
      `/net/neoforged/forge/${gameVersion}-${loaderVersion}` +
      `/forge-${gameVersion}-${loaderVersion}-installer.jar`
    return absoluteUrl(OFFICIAL_LOADER_BASES.neoforge.maven, relative)
  }
  return absoluteUrl(
    OFFICIAL_LOADER_BASES.neoforge.maven,
    `/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
  )
}

/**
 * 用官方安装器安装 Forge / NeoForge。
 *
 * 安装器要求「类 .minecraft」的目标目录（`versions/`、`libraries/`、
 * `launcher_profiles.json`）。实例目录不是这个形状，所以安装器跑在实例内的
 * 暂存目录里，装完把版本档案与客户端 jar 搬进实例根、库并入共享库目录。
 */
export async function installWithInstaller(
  kind: LoaderSourceKind,
  input: LoaderPrepareInput,
  runtime: LoaderRuntime
): Promise<LoaderPrepareResult> {
  const { gameVersion, loaderVersion, instanceDir, parent } = input
  const stagingDir = path.join(instanceDir, STAGING_DIR)
  const parentDir = path.join(stagingDir, 'versions', gameVersion)
  const workDir = path.join(instanceDir, WORK_DIR)
  await mkdir(parentDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  // 安装器需要暂存目录里的原版客户端 jar（旧版安装器还会读取版本文件）
  await writeFile(
    path.join(parentDir, `${gameVersion}.json`),
    JSON.stringify(parent, null, 2),
    'utf8'
  )

  const client = parent.downloads?.client
  if (!client?.url) throw new Error('原版版本文件缺少客户端下载地址，无法安装加载器')
  runtime.report(`下载原版客户端（${LOADER_LABELS[kind]} 安装器需要）`)
  runtime.log('info', `下载原版客户端 ${gameVersion}.jar（安装器需要）`)
  await runtime.download(
    client.url,
    path.join(parentDir, `${gameVersion}.jar`),
    client.sha1 ?? '',
    client.size ?? 0,
    input.clientSources ? { sources: input.clientSources } : undefined
  )

  // 官方安装器的 ClientInstall 会先检查启动器档案文件；暂存目录是新建的，
  // 这里补一个最小档案，安装完成后随暂存目录一起删除
  await writeFile(
    path.join(stagingDir, 'launcher_profiles.json'),
    JSON.stringify({ profiles: {} }, null, 2),
    'utf8'
  )

  const installerPath = path.join(workDir, 'installer.jar')
  runtime.report(`下载 ${LOADER_LABELS[kind]} 安装器`)
  runtime.log('info', `下载 ${LOADER_LABELS[kind]} 安装器：${gameVersion}-${loaderVersion}`)
  await runtime.download(installerUrl(kind, gameVersion, loaderVersion), installerPath)

  // 安装器会自己从官方 maven 逐一下载处理器依赖，国内常常只有几 KB/s，整个安装
  // 能拖上几分钟。先用镜像把它声明的库取好放进它自己的 libraries/，安装器发现
  // 文件已在且摘要一致就会跳过下载，只跑处理器。
  try {
    await prefetchInstallerLibraries(installerPath, kind, {
      librariesDir: path.join(stagingDir, 'libraries'),
      sharedLibrariesDir: input.librariesDir,
      label: LOADER_LABELS[kind],
      download: (url, target, sha1 = '', size = 0) =>
        runtime.download(url, target, sha1, size, { reportProgress: false }),
      report: (note, percent) => runtime.report(note, percent),
      log: (level, message) => runtime.log(level, message)
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    runtime.log('warn', `预取安装器依赖库失败，交给安装器自行下载：${message}`)
  }

  const logFile = path.join(workDir, 'installer.log')
  runtime.report(`安装 ${LOADER_LABELS[kind]}`)
  runtime.log('info', `运行 ${LOADER_LABELS[kind]} 安装器`)
  try {
    await runtime.runJava({
      args: ['-jar', installerPath, '--installClient', stagingDir],
      cwd: stagingDir,
      logFile,
      requiredMajor: parent.javaVersion?.majorVersion ?? 8
    })
  } catch (cause) {
    const detail = await tailText(logFile)
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(detail ? `${message}\n${detail}` : message, { cause })
  }

  const installed = await findInstalledVersion(stagingDir, gameVersion)
  await promoteInstallerOutput(
    instanceDir,
    installed.id,
    gameVersion,
    stagingDir,
    input.librariesDir
  )
  runtime.log('info', `${LOADER_LABELS[kind]} 安装器完成：${installed.id}`)
  return { versionId: installed.id, version: installed.version, mode: 'installer' }
}

// ---------------------------------------------------------------------------
// 版本列表通用工具
// ---------------------------------------------------------------------------

/** 解析 maven-metadata.xml 里的版本列表（只找 <version> 节点） */
export function parseMavenVersions(xml: string): string[] {
  const versions: string[] = []
  const pattern = /<version>([^<]+)<\/version>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1]?.trim()
    if (value) versions.push(value)
  }
  return versions
}

export function isPrerelease(version: string): boolean {
  return /-(beta|alpha|pre|rc)/i.test(version)
}

export function compareSegments(a: string, b: string): number {
  const left = a.split(/[.+-]/)
  const right = b.split(/[.+-]/)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftText = left[index] ?? ''
    const rightText = right[index] ?? ''
    const leftNumber = Number(leftText)
    const rightNumber = Number(rightText)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
      continue
    }
    const compared = leftText.localeCompare(rightText)
    if (compared !== 0) return compared
  }
  return 0
}

/**
 * 等待一组请求，但最多等 `graceMs`；到点时返回已经完成的结果。
 *
 * 用于 Forge / NeoForge：BMCLAPI 的列表很快，官方接口很慢，不能为了合并
 * 渠道信息把界面一直卡在加载态。
 */
export async function settleWithin<T>(promises: Promise<T>[], graceMs: number): Promise<T[]> {
  const results: T[] = []
  const all = promises.map((promise) =>
    promise.then(
      (value) => {
        results.push(value)
      },
      () => undefined
    )
  )
  await Promise.race([
    Promise.all(all),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs))
  ])
  return results.slice()
}

export function isBmclHost(origin: string): boolean {
  return origin.includes('bangbang93.com')
}

/** 合并多个来源返回的加载器版本；保留已补充的日期信息 */
export function mergeLoaderVersions(lists: LoaderVersion[][]): LoaderVersion[] {
  const merged = new Map<string, LoaderVersion>()
  for (const list of lists) {
    for (const version of list) {
      const existing = merged.get(version.id)
      if (!existing) {
        merged.set(version.id, { ...version })
        continue
      }
      if (!existing.date && version.date) existing.date = version.date
    }
  }
  return [...merged.values()].sort((a, b) => compareSegments(b.id, a.id))
}
