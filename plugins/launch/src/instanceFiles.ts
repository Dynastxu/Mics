import { existsSync, type Dirent, type Stats } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type {
  InstanceArea,
  InstanceDetail,
  InstanceLogContent,
  InstanceLogFile,
  InstanceModEntry,
  InstanceMods,
  InstanceUsage,
  InstanceUsageEntry,
} from './shared'
import { countMods, isSafeInstanceId, loaderLabel, resolveInstance } from './instances'

/** 详情页一次最多读取的日志字节数 */
const MAX_LOG_BYTES = 512 * 1024
/** 压缩日志先限制压缩体积，避免解压一个超大归档 */
const MAX_COMPRESSED_LOG_BYTES = 32 * 1024 * 1024
/** 解压后的上限；正常日志远小于这个值 */
const MAX_DECOMPRESSED_LOG_BYTES = 64 * 1024 * 1024

interface Measurement {
  size: number
  files: number
}

interface Tail {
  content: string
  truncated: boolean
}

const LOG_EXTENSIONS = ['.log', '.log.gz', '.txt']
const MOD_FILE = /\.jar(?:\.disabled)?$/i
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 实例根目录；非法 id 返回 null，绝不拼接出 instances 之外的位置 */
export function instanceDirOf(userDataDir: string, id: string): string | null {
  if (typeof id !== 'string' || !isSafeInstanceId(id)) return null
  const root = path.resolve(userDataDir, 'instances')
  const dir = path.resolve(root, id)
  return path.dirname(dir) === root ? dir : null
}

async function requireInstanceDir(userDataDir: string, id: string): Promise<string> {
  const dir = instanceDirOf(userDataDir, id)
  if (!dir) throw new Error('实例不存在')
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw new Error('实例不存在')
  return dir
}

/** 只接受日志 / Mod 这类单层文件名，挡住路径分隔符与 Windows 保留字符 */
function isPlainFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    path.basename(value) === value &&
    !UNSAFE_FILE_CHARS.test(value)
  )
}

function isLogFile(name: string): boolean {
  const lower = name.toLowerCase()
  return LOG_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function isModFile(name: string): boolean {
  return MOD_FILE.test(name)
}

export function describeInstance(userDataDir: string, id: string): InstanceDetail {
  const instance = resolveInstance(userDataDir, id)
  if (!instance) throw new Error('实例不存在或缺少版本文件')

  return {
    id: instance.id,
    name: instance.name,
    dir: instance.dir,
    versionDir: instance.versionDir,
    versionId: instance.version.id,
    minecraft: instance.version.inheritsFrom ?? instance.version.id,
    loader: loaderLabel(instance.version),
    versionType: instance.version.type ?? null,
    javaMajor: instance.version.javaVersion?.majorVersion ?? null,
    mods: countMods(instance.dir),
  }
}

async function measureFile(file: string): Promise<Measurement> {
  try {
    const info = await stat(file)
    return { size: info.isFile() ? info.size : 0, files: info.isFile() ? 1 : 0 }
  } catch {
    return { size: 0, files: 0 }
  }
}

/** 并发读取文件大小；避免大目录里成千上万次串行 stat */
async function measureFiles(files: string[]): Promise<Measurement> {
  const workers = Math.min(32, files.length)
  let cursor = 0
  let size = 0
  let count = 0

  const run = async (): Promise<void> => {
    while (true) {
      const file = files[cursor]
      cursor += 1
      if (!file) return
      const measured = await measureFile(file)
      size += measured.size
      count += measured.files
    }
  }

  await Promise.all(Array.from({ length: workers }, run))
  return { size, files: count }
}

/** 递归统计目录；跳过符号链接与读不到的条目，避免一次权限错误中断整个统计 */
async function measureTree(root: string): Promise<Measurement> {
  const stack = [root]
  const files: string[] = []

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    let entries: Dirent[] = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
      } else if (entry.isFile()) {
        files.push(target)
      }
    }
  }

  return measureFiles(files)
}

/**
 * 统计实例占用。
 *
 * 顶层目录单独计数，供详情页展示「占用构成」；直接放在实例根目录的文件
 * 归入 `.` 一项。资产目录可能有大量小文件，因此整个统计是异步的，
 * 由单独 RPC 触发，不阻塞详情主体。
 */
export async function measureInstanceUsage(userDataDir: string, id: string): Promise<InstanceUsage> {
  const root = await requireInstanceDir(userDataDir, id)

  let children: Dirent[] = []
  try {
    children = await readdir(root, { withFileTypes: true })
  } catch {
    children = []
  }

  const measured = await Promise.all(
    children.map(async (entry) => {
      if (entry.isSymbolicLink()) return null
      const target = path.join(root, entry.name)
      const result = entry.isDirectory() ? await measureTree(target) : await measureFile(target)
      return { name: entry.name, directory: entry.isDirectory(), ...result }
    }),
  )

  const entries: InstanceUsageEntry[] = []
  let looseSize = 0
  let looseFiles = 0

  for (const entry of measured) {
    if (!entry) continue
    if (entry.directory) {
      entries.push({ name: entry.name, size: entry.size, files: entry.files })
    } else {
      looseSize += entry.size
      looseFiles += entry.files
    }
  }

  if (looseFiles > 0) entries.push({ name: '.', size: looseSize, files: looseFiles })
  entries.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))

  return {
    total: entries.reduce((sum, entry) => sum + entry.size, 0),
    files: entries.reduce((sum, entry) => sum + entry.files, 0),
    entries,
    computedAt: Date.now(),
  }
}

export async function listInstanceLogs(userDataDir: string, id: string): Promise<InstanceLogFile[]> {
  const dir = path.join(await requireInstanceDir(userDataDir, id), 'logs')

  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: InstanceLogFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isLogFile(entry.name)) continue
    try {
      const info = await stat(path.join(dir, entry.name))
      files.push({ name: entry.name, size: info.size, modified: info.mtimeMs })
    } catch {
      // 统计期间被游戏轮转掉的文件直接忽略
    }
  }

  return files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
}

function tailBuffer(buffer: Buffer, limit: number): Tail {
  if (buffer.length <= limit) return { content: buffer.toString('utf8'), truncated: false }

  const start = buffer.length - limit
  const newline = buffer.indexOf(0x0a, start)
  if (newline < 0) return { content: '', truncated: true }
  return { content: buffer.subarray(newline + 1).toString('utf8'), truncated: true }
}

async function readFileTail(file: string, size: number, limit: number): Promise<Tail> {
  const length = Math.min(size, limit)
  const start = size - length
  const handle = await open(file, 'r')

  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const actual = buffer.subarray(0, bytesRead)
    if (start === 0) return { content: actual.toString('utf8'), truncated: false }

    // 从行边界开始，避免把多字节字符或半行内容显示出来
    const newline = actual.indexOf(0x0a)
    if (newline < 0) return { content: '', truncated: true }
    return { content: actual.subarray(newline + 1).toString('utf8'), truncated: true }
  } finally {
    await handle.close()
  }
}

/**
 * 读取一个日志文件的末尾内容。
 *
 * 日志可能很大，页面只取最后 512 KB；压缩归档先解压再截尾。返回的
 * `truncated` 用于提示「仅显示末尾内容」。
 */
export async function readInstanceLog(
  userDataDir: string,
  id: string,
  name: string,
): Promise<InstanceLogContent> {
  if (!isPlainFileName(name) || !isLogFile(name)) throw new Error('无效的日志文件')

  const dir = path.join(await requireInstanceDir(userDataDir, id), 'logs')
  const file = path.join(dir, name)

  let info: Stats
  try {
    info = await stat(file)
  } catch {
    throw new Error('日志文件不存在')
  }
  if (!info.isFile()) throw new Error('日志文件不存在')

  if (name.toLowerCase().endsWith('.gz')) {
    if (info.size > MAX_COMPRESSED_LOG_BYTES) throw new Error('压缩日志过大，无法在页面中打开')
    let text: Buffer
    try {
      text = gunzipSync(await readFile(file), { maxOutputLength: MAX_DECOMPRESSED_LOG_BYTES })
    } catch (cause) {
      throw new Error(`日志解压失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const tail = tailBuffer(text, MAX_LOG_BYTES)
    return {
      name,
      size: info.size,
      modified: info.mtimeMs,
      content: tail.content,
      truncated: tail.truncated,
    }
  }

  const tail = await readFileTail(file, info.size, MAX_LOG_BYTES)
  return {
    name,
    size: info.size,
    modified: info.mtimeMs,
    content: tail.content,
    truncated: tail.truncated,
  }
}

export async function listInstanceMods(userDataDir: string, id: string): Promise<InstanceMods> {
  const dir = path.join(await requireInstanceDir(userDataDir, id), 'mods')

  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { dir, entries: [] }
  }

  const mods: InstanceModEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isModFile(entry.name)) continue
    try {
      const info = await stat(path.join(dir, entry.name))
      mods.push({
        fileName: entry.name,
        name: entry.name.replace(MOD_FILE, ''),
        size: info.size,
        modified: info.mtimeMs,
        enabled: entry.name.toLowerCase().endsWith('.jar'),
      })
    } catch {
      // 读取期间被删除的文件直接忽略
    }
  }

  return {
    dir,
    entries: mods.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  }
}

/**
 * 启用 / 禁用 Mod。
 *
 * 用重命名表示开关（`foo.jar` ↔ `foo.jar.disabled`），与启动器之外的
 * 常见做法一致，游戏与加载器都不需要额外配置。目标文件名已存在时拒绝，
 * 避免静默覆盖另一个 Mod。
 */
export async function setInstanceModEnabled(
  userDataDir: string,
  id: string,
  fileName: string,
  enabled: boolean,
): Promise<InstanceMods> {
  if (!isPlainFileName(fileName) || !isModFile(fileName)) throw new Error('无效的 Mod 文件')

  const dir = path.join(await requireInstanceDir(userDataDir, id), 'mods')
  const source = path.join(dir, fileName)

  let info: Stats
  try {
    info = await stat(source)
  } catch {
    throw new Error('Mod 文件不存在')
  }
  if (!info.isFile()) throw new Error('Mod 文件不存在')

  const currentlyEnabled = fileName.toLowerCase().endsWith('.jar')
  if (currentlyEnabled === enabled) return listInstanceMods(userDataDir, id)

  const targetName = enabled ? fileName.replace(/\.disabled$/i, '') : `${fileName}.disabled`
  const target = path.join(dir, targetName)
  if (existsSync(target)) throw new Error(`目标文件已存在：${targetName}`)

  await rename(source, target)
  return listInstanceMods(userDataDir, id)
}

/** 打开实例目录前先确保目标存在；日志 / Mod 目录可以顺手创建 */
export async function resolveInstanceArea(
  userDataDir: string,
  id: string,
  area: InstanceArea = 'root',
): Promise<string> {
  const root = await requireInstanceDir(userDataDir, id)
  if (area === 'logs' || area === 'mods') {
    const target = path.join(root, area)
    await mkdir(target, { recursive: true })
    return target
  }
  return root
}

/** 删除实例目录；调用方负责先结束正在运行的进程 */
export async function deleteInstanceDirectory(userDataDir: string, id: string): Promise<void> {
  const dir = instanceDirOf(userDataDir, id)
  if (!dir) throw new Error('无效的实例 id')
  if (!existsSync(dir)) return

  // 刚结束的游戏进程可能还会短暂占用文件，交给 rm 重试而不是直接失败
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
