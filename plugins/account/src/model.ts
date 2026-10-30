import type { AccountKind, AccountSummary } from '@mics/sdk'
import { randomUUID, createHash } from 'node:crypto'

/** 主进程持久化的账户记录；令牌字段以 `secrets` 保存，渲染进程读不到 */
export interface StoredAccount {
  id: string
  kind: AccountKind
  name: string
  /** 带连字符的 UUID */
  uuid: string
  createdAt: number
  /** 加密后的令牌；正版只保存 refresh token */
  secrets?: Record<string, string>
  /** 令牌被判定失效时置 false，重新登录成功后恢复 */
  authorized?: boolean
}

export function newAccountId(): string {
  return randomUUID()
}

export function toSummary(account: StoredAccount): AccountSummary {
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    uuid: account.uuid,
    createdAt: account.createdAt,
    authorized: account.authorized !== false,
  }
}

/** 离线 UUID：与离线服务器一致的 `OfflinePlayer:<name>` md5 */
export function offlineUuid(name: string): string {
  const digest = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x30
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return dashed(hex)
}

function dashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 把 32 位十六进制或带连字符的 UUID 归一成带连字符的形式；无效时返回 null */
export function formatUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hex = raw.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return dashed(hex)
}

/** 玩家名：离线账户手填，正版以服务端档案为准 */
export function sanitizePlayerName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('玩家名不能为空')
  if ([...name].length > 16) throw new Error('玩家名不能超过 16 个字符')
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('玩家名不能包含控制字符')
  return name
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
