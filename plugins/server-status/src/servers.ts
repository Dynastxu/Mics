import { randomUUID } from 'node:crypto'
import type { StorageServiceApi } from '@mics/sdk'
import type { ServerEdition, ServerEntry, ServerInput } from './shared'

/**
 * 服务器列表的读写。
 *
 * 列表是「用户数据」而不是设置项：它没有固定键名，也不能用 JSON Schema 表达，
 * 因此直接放在插件存储的 `servers` 键里。首次出现时写入内置的两台服务器；
 * 用户把它们删掉之后键仍然存在（空数组），不会再被写回来。
 */

const STORAGE_KEY = 'servers'
const MAX_SERVERS = 50
const DEFAULT_JAVA_PORT = 25565
const DEFAULT_BEDROCK_PORT = 19132
const MAX_LABEL_LENGTH = 60

/** 首次出现时的内置列表：两家有代表性的公共服务器，可删除 */
export const DEFAULT_SERVERS: readonly ServerEntry[] = [
  {
    id: 'hypixel',
    host: 'mc.hypixel.net',
    port: DEFAULT_JAVA_PORT,
    edition: 'java',
    label: 'Hypixel'
  },
  { id: '2b2t', host: '2b2t.org', port: DEFAULT_JAVA_PORT, edition: 'java', label: '2b2t' }
]

/**
 * 主机名或 IPv4 地址。
 *
 * 只接受 ASCII 域名与点分地址：IPv6 的方括号写法在 mcstatus.io 上另有规则，
 * 这里直接拒绝并给出提示，而不是把可疑字符串拼进请求地址。
 */
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function editionOf(value: unknown, fallback: ServerEdition): ServerEdition {
  if (value === 'java' || value === 'bedrock') return value
  return fallback
}

/** 入参里的版本只接受 java / bedrock；缺省按 Java 版处理 */
function requestedEdition(value: unknown): ServerEdition {
  if (value === undefined || value === null || value === '') return 'java'
  if (value === 'java' || value === 'bedrock') return value
  throw new Error('版本只能是 java 或 bedrock')
}

function defaultPortOf(edition: ServerEdition): number {
  return edition === 'bedrock' ? DEFAULT_BEDROCK_PORT : DEFAULT_JAVA_PORT
}

function parsePort(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return null
  return numeric
}

/** 把 `host:port` 拆成主机与端口；没有端口时 `port` 为 undefined */
function splitAddress(raw: string): { host: string; port?: string } {
  const text = raw.trim()
  const index = text.lastIndexOf(':')
  if (index < 0) return { host: text }
  const host = text.slice(0, index).trim()
  const port = text.slice(index + 1).trim()
  return port ? { host, port } : { host }
}

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase()
  if (!host) throw new Error('需要填写服务器地址')
  if (host.includes('[') || host.includes(']')) {
    throw new Error('暂不支持 IPv6 地址，请填写主机名或 IPv4 地址')
  }
  if (!HOST_PATTERN.test(host)) throw new Error('服务器地址不合法，只能填主机名或 IPv4 地址')
  return host
}

function normalizeLabel(
  value: unknown,
  host: string,
  port: number,
  edition: ServerEdition
): string {
  const label = textOf(value).slice(0, MAX_LABEL_LENGTH)
  if (label) return label
  return port === defaultPortOf(edition) ? host : `${host}:${port}`
}

/**
 * 读取一条存储记录。
 *
 * 只做减损归一化：损坏的条目直接丢弃，不让一个手改过的 JSON 把整页带崩。
 */
function readEntry(value: unknown): ServerEntry | null {
  if (!isRecord(value)) return null
  const host = textOf(value.host).toLowerCase()
  if (!HOST_PATTERN.test(host)) return null
  const edition = editionOf(value.edition, 'java')
  const port = parsePort(value.port) ?? defaultPortOf(edition)
  const id = textOf(value.id) || randomUUID()
  return { id, host, port, edition, label: normalizeLabel(value.label, host, port, edition) }
}

export class ServerStore {
  constructor(private readonly storage: StorageServiceApi) {
    this.seed()
  }

  list(): ServerEntry[] {
    const raw = this.storage.get<unknown>(STORAGE_KEY)
    if (!Array.isArray(raw)) return []
    return raw
      .map((entry) => readEntry(entry))
      .filter((entry): entry is ServerEntry => entry !== null)
  }

  /** 添加一台服务器；地址支持 `host` 与 `host:port` 两种写法 */
  add(input: ServerInput): ServerEntry {
    const list = this.list()
    if (list.length >= MAX_SERVERS) throw new Error(`最多只能保存 ${MAX_SERVERS} 台服务器`)

    const { host: rawHost, port: rawPort } = splitAddress(textOf(input?.address))
    const edition = requestedEdition(input?.edition)
    const host = normalizeHost(rawHost)
    const inlinePort = rawPort === undefined ? null : parsePort(rawPort)
    if (rawPort !== undefined && inlinePort === null) throw new Error('端口需要在 1-65535 之间')
    const port = inlinePort ?? defaultPortOf(edition)

    if (list.some((entry) => sameTarget(entry, host, port, edition))) {
      throw new Error('这台服务器已经在列表里')
    }

    const entry: ServerEntry = {
      id: randomUUID(),
      host,
      port,
      edition,
      label: normalizeLabel(input?.label, host, port, edition)
    }
    this.write([...list, entry])
    return entry
  }

  /** 删除一台服务器；返回被删掉的条目，调用方据此清理查询缓存 */
  remove(id: unknown): ServerEntry {
    const target = textOf(id)
    const list = this.list()
    const entry = list.find((item) => item.id === target)
    if (!entry) throw new Error('服务器不在列表里')
    this.write(list.filter((item) => item.id !== target))
    return entry
  }

  /** 键存在（哪怕是空数组）就不再写默认值：用户删掉的服务器不该自己回来 */
  private seed(): void {
    if (Array.isArray(this.storage.get<unknown>(STORAGE_KEY))) return
    this.write(DEFAULT_SERVERS.map((entry) => ({ ...entry })))
  }

  private write(list: ServerEntry[]): void {
    this.storage.set(STORAGE_KEY, list)
  }
}

function sameTarget(
  entry: ServerEntry,
  host: string,
  port: number,
  edition: ServerEdition
): boolean {
  return entry.host === host && entry.port === port && entry.edition === edition
}
