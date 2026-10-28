import type { LogSettings, StorageServiceApi } from '@mics/sdk'
import { DEFAULT_LOG_MAX_FILES, normalizeLogMaxFiles } from '@mics/sdk'

/** 存储键；storage 已按插件隔离，无需再加插件前缀 */
const MAX_FILES_KEY = 'maxFiles'

/** 读取设置；缺失或损坏时退回默认的 5 个 */
export function readLogSettings(storage: StorageServiceApi): LogSettings {
  return {
    maxFiles: normalizeLogMaxFiles(
      storage.get<unknown>(MAX_FILES_KEY, DEFAULT_LOG_MAX_FILES),
      DEFAULT_LOG_MAX_FILES,
    ),
  }
}

/** 归一化后写回，返回实际生效的保留数量 */
export function writeLogSettings(storage: StorageServiceApi, maxFiles: unknown): number {
  const normalized = normalizeLogMaxFiles(maxFiles)
  storage.set(MAX_FILES_KEY, normalized)
  return normalized
}
