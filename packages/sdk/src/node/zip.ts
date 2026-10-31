import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * 最小 Zip 读取 / 解压实现。
 *
 * 下载管线与启动插件都需要读 jar / 整合包，而 Electron / Node 没有内置 zip
 * 模块；这里只实现需要的部分：解析中央目录、读取单个条目、按需解压。
 * 不引入第三方依赖，插件产物可以继续独立分发。
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT = 0xffff

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

/** 解析中央目录；不是有效 Zip 时抛错 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
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
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** 读取并解压单个条目；不支持的压缩方式或损坏条目返回 null */
export function zipEntryData(buffer: Buffer, entry: ZipEntry): Buffer | null {
  if (entry.localOffset + 30 > buffer.length) return null
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

/**
 * 判断 buffer 是否是结构完整的 Zip / jar。
 *
 * 只看文件头不够：断点续传时服务端忽略 Range 会把完整文件追加到残缺的
 * `.part` 后面，文件仍以 `PK` 开头但中央目录偏移全部错位。这里对齐 EOCD、
 * 中央目录与首个本地头。
 */
export function isReadableZipBuffer(buffer: Buffer): boolean {
  if (buffer.length < 22) return false

  const start = Math.max(0, buffer.length - MAX_COMMENT - 22)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return false

  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0 || cdOffset + 46 > buffer.length) return false
  if (buffer.readUInt32LE(cdOffset) !== CENTRAL_SIGNATURE) return false

  const localOffset = buffer.readUInt32LE(cdOffset + 42)
  return localOffset + 4 <= buffer.length
    && buffer.readUInt32LE(localOffset) === LOCAL_SIGNATURE
}

/**
 * 规范化 Zip 条目路径。
 *
 * 返回 null 表示条目不应落盘：绝对路径、盘符、`..` 越界与空路径都会被拒绝，
 * 避免恶意整合包把文件写到实例目录之外。
 */
export function safeZipEntryPath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

/** 从已读入内存的归档里读取文本条目；不存在或无法解压时返回 null */
export function readZipTextFromBuffer(buffer: Buffer, name: string): string | null {
  const entries = readZipEntries(buffer)
  const entry = entries.find((item) => item.name === name || item.name === `./${name}`)
  if (!entry) return null
  const data = zipEntryData(buffer, entry)
  return data ? data.toString('utf8') : null
}

/** 读取归档里的一个文本条目；不存在或不是文本时返回 null */
export async function readZipText(archive: string, name: string): Promise<string | null> {
  return readZipTextFromBuffer(await readFile(archive), name)
}

export interface ZipExtractOptions {
  /**
   * 把归档内路径映射成目标相对路径；返回 null 表示跳过该条目。
   *
   * 这是整合包「overrides/ 前缀去掉、只解压覆盖文件」的挂点。
   */
  map?: (entry: ZipEntry, relative: string) => string | null
}

export interface ZipExtractResult {
  /** 归档里的条目总数 */
  entries: number
  /** 实际写出的文件数 */
  files: number
}

/**
 * 解压归档到目标目录。
 *
 * 目录条目会创建空目录；加密 / 不支持的压缩方式直接报错，避免留下半套文件
 * 却在界面上显示「安装完成」。
 */
export async function extractZipEntries(
  archive: string,
  dest: string,
  options: ZipExtractOptions = {},
): Promise<ZipExtractResult> {
  const buffer = await readFile(archive)
  const entries = readZipEntries(buffer)
  let files = 0

  for (const entry of entries) {
    const relative = safeZipEntryPath(entry.name)
    if (!relative) continue

    const targetRelative = options.map
      ? options.map(entry, relative)
      : relative
    if (!targetRelative) continue

    const safeTarget = safeZipEntryPath(targetRelative)
    if (!safeTarget) throw new Error(`归档包含不安全的路径：${entry.name}`)

    const target = path.join(dest, safeTarget)
    if (entry.name.endsWith('/') || safeTarget.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }

    const data = zipEntryData(buffer, entry)
    if (!data) throw new Error(`无法解压归档条目：${entry.name}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
    files += 1
  }

  return { entries: entries.length, files }
}
