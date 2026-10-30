import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/**
 * 从 jar 里读一个文本条目。
 *
 * 只服务安装器：Forge / NeoForge 的 installer.jar 里带着 `install_profile.json`
 * 与 `version.json`，安装器启动前需要先按它们把依赖库取好（见 installerLibraries）。
 * 这里刻意只读中央目录 + 单条 inflate，不引入解压依赖，也不整包解压。
 */

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
