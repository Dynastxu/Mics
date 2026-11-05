import type { StorageServiceApi } from '@mics/sdk'

/**
 * 部署相关参数全部走 `contributes.configuration`。
 *
 * 默认值同时写在 `plugin.json` 与这里：前者决定设置页显示什么，后者保证
 * 旧数据、损坏值或 profile 覆盖都不会把插件带进非法状态。
 */

export const DEFAULT_BASE_URL = 'https://api.minekuai.cn'

export interface MineKuaiSettings {
  enabled: boolean
  baseUrl: string
  timeoutMs: number
  budgetMs: number
  cacheTtlMinutes: number
  maxCandidates: number
  concurrency: number
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function integerOf(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

/** 只接受 http/https，去掉末尾斜杠；非法值回退默认地址 */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BASE_URL
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE_URL
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_BASE_URL
    return trimmed
  } catch {
    return DEFAULT_BASE_URL
  }
}

export function readMineKuaiSettings(storage: StorageServiceApi): MineKuaiSettings {
  return {
    enabled: booleanOf(storage.get<unknown>('enabled', true), true),
    baseUrl: normalizeBaseUrl(storage.get<unknown>('baseUrl', DEFAULT_BASE_URL)),
    timeoutMs: integerOf(storage.get<unknown>('timeoutMs', 5000), 5000, 500, 15000),
    budgetMs: integerOf(storage.get<unknown>('budgetMs', 3500), 3500, 500, 15000),
    cacheTtlMinutes: integerOf(storage.get<unknown>('cacheTtlMinutes', 10), 10, 1, 10080),
    maxCandidates: integerOf(storage.get<unknown>('maxCandidates', 5), 5, 1, 50),
    concurrency: integerOf(storage.get<unknown>('concurrency', 6), 6, 1, 8)
  }
}
