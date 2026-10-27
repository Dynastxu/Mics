import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

const NATIVE_PATTERN = /\.(dll|so|dylib|jnilib)$/i

/**
 * 把 native jar 里的动态库平铺解压到目标目录。
 * 只提取动态库文件，忽略 META-INF 与类文件。
 */
export function extractNativeLibraries(jarPath: string, destDir: string): string[] {
  const buffer = readFileSync(jarPath)
  const entries = readEntries(buffer)
  mkdirSync(destDir, { recursive: true })

  const extracted: string[] = []
  for (const entry of entries) {
    if (!NATIVE_PATTERN.test(entry.name) || entry.name.startsWith('META-INF/')) continue
    if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) continue

    const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
    const dataStart = entry.localOffset + 30 + nameLength + extraLength
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize)

    let output: Buffer
    if (entry.method === 0) {
      output = data
    } else if (entry.method === 8) {
      output = inflateRawSync(data)
    } else {
      continue
    }

    const fileName = path.basename(entry.name)
    writeFileSync(path.join(destDir, fileName), output)
    extracted.push(fileName)
  }

  return extracted
}
