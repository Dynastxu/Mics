import http from 'node:http'
import https from 'node:https'
import { micsUserAgent } from '../brand'

/**
 * 元数据请求的共享实现。
 *
 * 只做小体积文本 / JSON：版本清单、加载器 meta、社区 API。文件下载、断点续传
 * 与缓存属于下载管线，不在这里。调用方传入应用版本，SDK 因此不依赖 Electron。
 */

export interface HttpOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** 默认 GET；指纹接口需要 POST */
  method?: 'GET' | 'POST'
  /** JSON 请求体 */
  body?: string
  /** 应用版本；用于拼统一的 User-Agent */
  appVersion?: string
}

const DEFAULT_TIMEOUT = 30_000
const MAX_REDIRECTS = 8

export function requestText(
  url: string,
  options: HttpOptions = {},
  redirects = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('重定向次数过多'))
      return
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`无效的接口地址：${url}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`不支持的接口协议：${parsed.protocol}`))
      return
    }

    const secure = parsed.protocol === 'https:'
    const proto = secure ? https : http
    const method = options.method ?? 'GET'
    const req = proto.request(
      url,
      {
        method,
        signal: options.signal,
        headers: {
          'User-Agent': micsUserAgent(options.appVersion ?? ''),
          Accept: 'application/json',
          // 不解压响应体：JSON.parse 拿到压缩字节只会报「不是有效 JSON」
          'Accept-Encoding': 'identity',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers
        }
      },
      (res) => {
        const status = res.statusCode ?? 0

        if (status >= 300 && status < 400) {
          res.resume()
          const location = res.headers.location
          if (!location) {
            reject(new Error(`HTTP ${status}`))
            return
          }
          let next: string
          try {
            next = new URL(location, url).toString()
          } catch {
            reject(new Error(`无效的重定向地址：${location}`))
            return
          }
          // 跨站重定向时不携带 API Key 等自定义头
          const sameOrigin = new URL(next).origin === parsed.origin
          const nextOptions = sameOrigin ? options : { ...options, headers: {} }
          requestText(next, nextOptions, redirects + 1).then(resolve, reject)
          return
        }

        if (status >= 400) {
          let detail = ''
          res.setEncoding('utf-8')
          res.on('data', (chunk: string) => {
            if (detail.length < 512) detail += chunk
          })
          res.on('end', () => {
            const suffix = detail.trim() ? `：${detail.trim().slice(0, 240)}` : ''
            reject(new Error(`HTTP ${status}${suffix}`))
          })
          res.on('error', reject)
          return
        }

        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          data += chunk
        })
        res.on('end', () => resolve(data))
        res.on('error', reject)
      }
    )

    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

export async function requestJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const text = await requestText(url, options)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('接口返回的不是有效 JSON')
  }
}

/** 拼接接口根地址与路径，避免 `//` 或漏掉 `/`；允许只填主机名 */
export function endpoint(base: string, path: string): string {
  let root = base.trim().replace(/\/+$/, '')
  if (root && !/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) root = `https://${root}`
  const suffix = path.replace(/^\/+/, '')
  return suffix ? `${root}/${suffix}` : root
}

/** 给 URL 附加查询参数；空字符串值会被跳过 */
export function withParams(url: string, params: Record<string, string>): string {
  const target = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value)
  }
  return target.toString()
}

export interface FirstRequestOptions<T> {
  signal?: AbortSignal
  appVersion?: string
  timeoutMs?: number
  headers?: Record<string, string>
  parse: (text: string) => T
  emptyMessage?: string
}

/**
 * 在所有候选地址上并行请求同一份元数据，最先成功的返回。
 *
 * 串行重试时，一个不可达的源会把「点击安装」拖住整整一个超时周期；并行后
 * 慢源不再影响结果，取消时也能立刻中断所有请求。
 */
export async function fetchFirst<T>(
  targets: string[],
  options: FirstRequestOptions<T>
): Promise<T> {
  if (targets.length === 0) throw new Error(options.emptyMessage ?? '没有可用的下载源')

  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', forwardAbort, { once: true })
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const attempts = targets.map((target) => {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`请求超时：${target}`)), timeoutMs)
      controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
    })
    return Promise.race([
      requestText(target, {
        signal: controller.signal,
        appVersion: options.appVersion,
        headers: options.headers
      }).then(options.parse),
      timeout
    ])
  })

  try {
    return await Promise.any(attempts)
  } catch (cause) {
    if (cause instanceof AggregateError) {
      const reasons = cause.errors.map((error) =>
        error instanceof Error ? error : new Error(String(error))
      )
      throw reasons.find((reason) => reason.name !== 'AbortError') ?? reasons[0] ?? cause
    }
    throw cause
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
    controller.abort()
  }
}
