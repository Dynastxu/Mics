import type { StorageServiceApi } from '@mics/sdk'
import type { ServerStatusSettings } from './shared'
import { DEFAULT_SETTINGS, MIN_REFRESH_SECONDS } from './shared'

/**
 * 部署相关参数全部走 `contributes.configuration`。
 *
 * 默认值同时写在 `plugin.json` 与这里：前者决定设置页显示什么，后者保证
 * 旧数据、损坏值或 profile 覆盖都不会把插件带进非法状态。
 */

const MAX_REFRESH_SECONDS = 3600

function integerOf(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

/**
 * 只接受 http/https 并去掉末尾斜杠。
 *
 * mcstatus.io 的地址由 node-mcstatus 拼成 `<baseURL>/status/java/<host>:<port>`，
 * 因此这里不能带查询串或路径尾部的多余斜杠；非法值直接回退默认地址。
 */
export function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.apiBaseUrl
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_SETTINGS.apiBaseUrl
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_SETTINGS.apiBaseUrl
    if (url.search || url.hash) return DEFAULT_SETTINGS.apiBaseUrl
    return trimmed
  } catch {
    return DEFAULT_SETTINGS.apiBaseUrl
  }
}

export function readServerStatusSettings(storage: StorageServiceApi): ServerStatusSettings {
  return {
    apiBaseUrl: normalizeApiBaseUrl(
      storage.get<unknown>('apiBaseUrl', DEFAULT_SETTINGS.apiBaseUrl)
    ),
    refreshSeconds: integerOf(
      storage.get<unknown>('refreshSeconds', DEFAULT_SETTINGS.refreshSeconds),
      DEFAULT_SETTINGS.refreshSeconds,
      MIN_REFRESH_SECONDS,
      MAX_REFRESH_SECONDS
    )
  }
}
