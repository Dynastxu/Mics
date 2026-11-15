import { statusBedrock, statusJava } from 'node-mcstatus'
import type { BedrockStatusResponse, JavaStatusResponse } from 'node-mcstatus'
import type { ServerEntry, ServerPlayers, ServerStatus, ServerStatusSettings } from './shared'

/**
 * mcstatus.io 查询。
 *
 * 三件事：
 *
 * - **限流**：mcstatus.io 按 IP 限制 5 次/秒，所有请求先过一个串行闸门，
 *   两次请求之间至少隔 `REQUEST_GAP_MS`，多台服务器排队也不会被 429。
 * - **缓存**：同一台服务器在 `MIN_CACHE_MS` 内只查一次，页面来回切换和
 *   打开多个窗口都不会放大请求量。
 * - **归一化**：把 Java / 基岩两种响应收敛成一个可序列化的形状；服务端给的
 *   HTML 不往页面传，只传纯文本行与校验过的图标 data URI。
 */

type StatusLogger = {
  warn(message: string, ...args: unknown[]): void
}

const REQUEST_GAP_MS = 240
const MIN_CACHE_MS = 10_000
/** node-mcstatus 没有超时参数，卡住时由这里放弃，避免页面一直停在「查询中」 */
const QUERY_TIMEOUT_MS = 12_000
/** 只接受真正的图片 data URI，避免把接口返回的任意字符串塞进 <img src> */
const ICON_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/
/** MOTD 最多保留几行；卡片按两行展示，多出来的行没有意义 */
const MAX_MOTD_LINES = 4

interface CachedStatus {
  status: ServerStatus
  expiresAt: number
}

interface StatusResult {
  status: ServerStatus
  expiresAt: number
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 查询失败时给用户看的说明；接口原文是纯文本，这里只做分类与本地化 */
function describeFailure(cause: unknown): string {
  const error = cause as { message?: unknown; response?: unknown } | null
  const response = isRecord(error?.response) ? error.response : undefined
  const status = typeof response?.status === 'number' ? response.status : 0
  const body =
    textOf(response?.text) ||
    textOf(response?.body) ||
    textOf(error?.message) ||
    String(cause ?? '')

  if (status === 429) return '请求过于频繁（mcstatus.io 限流），稍后再试'
  if (status >= 500) return `mcstatus.io 返回 HTTP ${status}`
  if (/invalid address/i.test(body)) return '地址无法解析，请检查主机名与端口'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(body)) {
    return '连不上 mcstatus.io，请检查网络'
  }
  if (!body || body === '[object Object]') return '查询失败，请稍后再试'
  return body
}

function playersOf(value: unknown): ServerPlayers | null {
  if (!isRecord(value)) return null
  const online = Number(value.online)
  const max = Number(value.max)
  if (!Number.isFinite(online) || !Number.isFinite(max)) return null
  return { online: Math.max(0, Math.trunc(online)), max: Math.max(0, Math.trunc(max)) }
}

/** 纯文本 MOTD 按行拆开：保留行首缩进（MOTD 靠空格居中），去掉行尾空白与空行 */
function motdLinesOf(value: unknown): string[] {
  const clean = textOf(value)
  if (!clean) return []
  return clean
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .slice(0, MAX_MOTD_LINES)
}

function iconOf(value: unknown): string | null {
  const icon = typeof value === 'string' ? value.trim() : ''
  return ICON_PATTERN.test(icon) ? icon : null
}

function baseStatus(server: ServerEntry, retrievedAt: unknown): ServerStatus {
  return {
    id: server.id,
    online: false,
    players: null,
    version: '',
    motd: [],
    icon: null,
    retrievedAt: typeof retrievedAt === 'number' ? retrievedAt : Date.now(),
    error: ''
  }
}

function mapJava(server: ServerEntry, response: JavaStatusResponse): ServerStatus {
  const status = baseStatus(server, response.retrieved_at)
  if (!response.online) return status
  return {
    ...status,
    online: true,
    players: playersOf(response.players),
    version: textOf(response.version?.name_clean),
    motd: motdLinesOf(response.motd?.clean),
    icon: iconOf(response.icon)
  }
}

function mapBedrock(server: ServerEntry, response: BedrockStatusResponse): ServerStatus {
  const status = baseStatus(server, response.retrieved_at)
  if (!response.online) return status
  return {
    ...status,
    online: true,
    players: playersOf(response.players),
    version: textOf(response.version?.name),
    motd: motdLinesOf(response.motd?.clean),
    // 基岩版不提供自定义图标
    icon: null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('查询超时')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export class ServerStatusService {
  private readonly cache = new Map<string, CachedStatus>()
  private readonly inFlight = new Map<string, Promise<ServerStatus>>()
  /** 串行闸门：后一个请求等前一个放行后再计算间隔 */
  private queue: Promise<void> = Promise.resolve()
  private lastRequestAt = 0

  constructor(
    private readonly settings: () => ServerStatusSettings,
    private readonly log: StatusLogger
  ) {}

  /** 查询多台服务器；返回顺序与入参一致，单台失败不影响其它服务器 */
  query(servers: ServerEntry[], force = false): Promise<ServerStatus[]> {
    return Promise.all(servers.map((server) => this.queryOne(server, force)))
  }

  /** 服务器被删除后清掉缓存，避免同样的 id 重新出现时显示旧结果 */
  forget(id: string): void {
    this.cache.delete(id)
    this.inFlight.delete(id)
  }

  private queryOne(server: ServerEntry, force: boolean): Promise<ServerStatus> {
    const cached = this.cache.get(server.id)
    if (!force && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.status)

    // 同一台服务器的并发请求合并成一次，`force` 也接受正在跑的那次：
    // 用户连点刷新时不该再额外消耗一次限流额度
    const running = this.inFlight.get(server.id)
    if (running) return running

    const task = this.request(server)
      .then(({ status, expiresAt }) => {
        const ttl = Math.max(MIN_CACHE_MS, expiresAt - Date.now())
        this.cache.set(server.id, { status, expiresAt: Date.now() + ttl })
        return status
      })
      .finally(() => {
        this.inFlight.delete(server.id)
      })
    this.inFlight.set(server.id, task)
    return task
  }

  private async request(server: ServerEntry): Promise<StatusResult> {
    await this.waitTurn()
    const settings = this.settings()
    try {
      return server.edition === 'bedrock'
        ? await this.requestBedrock(server, settings)
        : await this.requestJava(server, settings)
    } catch (cause) {
      const message = describeFailure(cause)
      this.log.warn('查询 %s 失败：%s', addressOf(server), message)
      return {
        status: { ...baseStatus(server, Date.now()), error: message },
        expiresAt: Date.now() + MIN_CACHE_MS
      }
    }
  }

  private async requestJava(
    server: ServerEntry,
    settings: ServerStatusSettings
  ): Promise<StatusResult> {
    const response = await withTimeout(
      statusJava(server.host, server.port, {
        baseURL: settings.apiBaseUrl,
        // 插件不展示 query 才有的插件/软件信息，关掉它可以少等 1 秒
        query: false
      }),
      QUERY_TIMEOUT_MS
    )
    return { status: mapJava(server, response), expiresAt: response.expires_at }
  }

  private async requestBedrock(
    server: ServerEntry,
    settings: ServerStatusSettings
  ): Promise<StatusResult> {
    const response = await withTimeout(
      statusBedrock(server.host, server.port, { baseURL: settings.apiBaseUrl }),
      QUERY_TIMEOUT_MS
    )
    return { status: mapBedrock(server, response), expiresAt: response.expires_at }
  }

  /** 排队并保证两次请求之间至少隔 `REQUEST_GAP_MS` */
  private waitTurn(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastRequestAt + REQUEST_GAP_MS - Date.now()
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
      this.lastRequestAt = Date.now()
    })
    this.queue = turn.catch(() => undefined)
    return turn
  }
}

export function addressOf(server: ServerEntry): string {
  return `${server.host}:${server.port}`
}
