import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT = 0xffff

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
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

const NATIVE_PATTERN = /\.(dll|so|dylib|jnilib)$/i

/**
 * 检查 jar 是否能被 JVM 正常读取。
 *
 * 只看文件头不够：下载中断后重试时，服务端忽略 Range 可能把完整文件追加到
 * 残缺的 `.part` 后面，得到的文件仍然以 `PK` 开头，但中央目录偏移全部错位，
 * JVM 会报 ClassNotFoundException。这里对齐 EOCD、中央目录与首个本地头。
 */
export function isReadableJar(file: string): boolean {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return false
  }
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
  const entries = readEntries(buffer)
  mkdirSync(destDir, { recursive: true })

  const files: string[] = []
  let locked = false

  for (const entry of entries) {
    if (!NATIVE_PATTERN.test(entry.name) || entry.name.startsWith('META-INF/')) continue
    if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) continue

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

    const data = entryData(buffer, entry)
    if (data) writeFileSync(target, data)
  }

  return { files, locked }
}
