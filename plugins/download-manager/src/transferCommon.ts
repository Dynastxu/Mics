import { createHash, type Hash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import type { Agent as HttpAgent } from 'node:http'
import type { Agent as HttpsAgent } from 'node:https'
import type { FileTransferSpec } from '@mics/sdk'

/**
 * 单文件传输实现共用的类型与小工具。
 *
 * 单连接与分段连接两条路径都必须遵守同一份契约：写 `<目标>.part`、
 * 成功后由调用方改名、暂停/失败保留断点。
 */

export interface TransferAgents {
  http: HttpAgent
  https: HttpsAgent
}

/** 本机实现需要的 agent 是具体类型，契约里只声明「透传」 */
export interface FileTransferOptions extends FileTransferSpec {
  agents: TransferAgents
}

/** 分段下载的断点元数据文件名；紧挨着 `.part` 存放 */
export const TRANSFER_STATE_SUFFIX = '.segments.json'

export function transferStatePath(partPath: string): string {
  return `${partPath}${TRANSFER_STATE_SUFFIX}`
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 读取分段元数据里已经完成的字节数；没有可用元数据时返回 null */
export function transferStateProgress(partPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(transferStatePath(partPath), 'utf8')) as {
      size?: unknown
      segments?: unknown
    }
    if (!Array.isArray(raw.segments)) return null
    let loaded = 0
    for (const entry of raw.segments) {
      if (!entry || typeof entry !== 'object') return null
      const value = (entry as { loaded?: unknown }).loaded
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      loaded += value
    }
    if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size > 0) {
      return Math.min(loaded, raw.size)
    }
    return loaded
  } catch {
    return null
  }
}

export async function hashRange(file: string, length: number, hash: Hash): Promise<void> {
  if (length <= 0) return
  const stream = createReadStream(file, { start: 0, end: length - 1 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
}

/** 计算完整文件的 SHA1；读失败时抛错，由调用方按传输失败处理 */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
