import http from 'node:http'
import https from 'node:https'

/**
 * Mod 目录的元数据请求。
 *
 * 与下载管线的文件请求分开：这里只做小体积 JSON，不需要断点续传和缓存，
 * 但必须支持自定义请求头（CurseForge 的 API Key）、超时与取消。
 */

export interface ModHttpOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** 默认 GET；指纹接口需要 POST */
  method?: 'GET' | 'POST'
  /** JSON 请求体 */
  body?: string
}

const DEFAULT_TIMEOUT = 30_000
const MAX_REDIRECTS = 5
const USER_AGENT = 'Mics'

export function requestText(
  url: string,
  options: ModHttpOptions = {},
  redirects = 0,
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
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          // 这里不解压响应体，明确要求明文，避免 JSON.parse 拿到压缩字节
          'Accept-Encoding': 'identity',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers,
        },
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
          requestText(
            next,
            sameOrigin ? options : { ...options, headers: {} },
            redirects + 1,
          ).then(resolve, reject)
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
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => resolve(data))
        res.on('error', reject)
      },
    )

    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

export async function requestJson<T>(
  url: string,
  options: ModHttpOptions = {},
): Promise<T> {
  const text = await requestText(url, options)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('接口返回的不是有效 JSON')
  }
}

/** 拼接接口根地址与路径，避免 `//` 或漏掉 `/`；允许像下载源一样只填主机名 */
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
