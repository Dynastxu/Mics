import {
  endpoint as sdkEndpoint,
  requestJson as sdkRequestJson,
  withParams as sdkWithParams
} from '@mics/sdk/main'
import type { HttpOptions } from '@mics/sdk/main'

/**
 * 来源插件的 HTTP 包装：统一带上应用版本（User-Agent）。
 *
 * 请求实现与超时 / 重定向 / 跨站去头逻辑在 `@mics/sdk/main`，这里只绑定版本。
 */

let appVersion = ''

export function setHttpAppVersion(value: string): void {
  appVersion = value
}

export function endpoint(base: string, path: string): string {
  return sdkEndpoint(base, path)
}

export function withParams(url: string, params: Record<string, string>): string {
  return sdkWithParams(url, params)
}

export function requestJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  return sdkRequestJson<T>(url, { ...options, appVersion })
}
