import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

/**
 * 把 `source` 目录的内容合并进 `target`。
 *
 * 默认同名文件由 `source` 覆盖；`overwrite: false` 时保留 `target` 里已有的文件，
 * 用于并入共享库目录——那里可能有别的实例正在用的同名文件，覆盖会截断正在被
 * 另一个进程读取的 jar。保留的文件稍后按 sha1 校验，损坏时由补全流程替换。
 * 结束后删除 `source`（含空目录）。
 */
export async function moveTreeInto(
  source: string,
  target: string,
  options: { overwrite?: boolean } = {},
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
