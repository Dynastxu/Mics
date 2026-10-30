/**
 * 账户登录用的极简 HTTP 客户端。
 *
 * 登录接口（Microsoft 的各段 OAuth / Xbox 端点）都返回 JSON 并用 HTTP 状态码 +
 * 错误体表达失败，这里把两者一起收进 `HttpRequestError`，让调用方能按
 * `status` / `code` 区分「等待授权」和真正的错误。
 */

const DEFAULT_TIMEOUT = 20_000

export class HttpRequestError extends Error {
  readonly status: number
  readonly data: unknown
  readonly code?: string

  constructor(message: string, status: number, data: unknown, code?: string) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = status
    this.data = data
    if (code) this.code = code
  }
}

export interface JsonRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT } = options

  let response: Response
  try {
    response = await fetch(url, {
      method,
      body,
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    throw new Error(`无法连接 ${url}：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const text = await response.text()
  let data: unknown = null
  if (text.trim()) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      if (response.ok) throw new Error(`响应不是有效的 JSON：${url}`)
    }
  }

  if (!response.ok) {
    throw new HttpRequestError(
      errorMessageOf(data, response.status, url),
      response.status,
      data,
      stringField(data, 'error'),
    )
  }
  if (data === null) throw new Error(`响应为空：${url}`)
  return data as T
}

function errorMessageOf(data: unknown, status: number, url: string): string {
  return (
    stringField(data, 'errorMessage') ??
    stringField(data, 'error_description') ??
    stringField(data, 'message') ??
    stringField(data, 'error') ??
    `HTTP ${status}：${url}`
  )
}

/** 把未知值收窄成对象；标量返回空对象，字段读取因此无需嵌套判空 */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function stringField(value: unknown, key: string): string | undefined {
  const field = recordOf(value)[key]
  return typeof field === 'string' && field ? field : undefined
}

export function numberField(value: unknown, key: string): number | undefined {
  const field = recordOf(value)[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

export function jsonBody(fields: unknown): string {
  return JSON.stringify(fields)
}
