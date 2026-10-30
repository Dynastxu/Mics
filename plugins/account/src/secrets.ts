import { safeStorage } from 'electron'

const SAFE_PREFIX = 'safe:'
const PLAIN_PREFIX = 'plain:'

/**
 * 令牌落盘前的保护。
 *
 * Windows / macOS 上走系统密钥环（Electron safeStorage）；平台没有可用密钥环时
 * 退回明文并加前缀，保持可读而非假装安全——重新登录永远可以恢复账户。
 */
export function seal(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return SAFE_PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    // 平台不支持时退到明文
  }
  return PLAIN_PREFIX + value
}

export function unseal(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith(SAFE_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(SAFE_PREFIX.length), 'base64'))
    } catch {
      // 换机器 / 密钥环被重置后解不开：按「需要重新登录」处理
      return null
    }
  }
  if (value.startsWith(PLAIN_PREFIX)) return value.slice(PLAIN_PREFIX.length)
  return value
}
