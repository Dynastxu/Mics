import type { AccountKind, AccountSnapshot, StorageServiceApi } from '@mics/sdk'
import { formatUuid, toSummary, type StoredAccount } from './model'

const ACCOUNTS_KEY = 'accounts'
const ACTIVE_KEY = 'activeAccountId'
const KINDS: readonly AccountKind[] = ['microsoft', 'offline']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKind(value: unknown): value is AccountKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** 读取落盘账户；损坏或旧格式的条目直接丢弃，不让一条坏数据挡住整个页面 */
function normalize(raw: unknown): StoredAccount[] {
  if (!Array.isArray(raw)) return []
  const accounts: StoredAccount[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    if (typeof entry.id !== 'string' || !entry.id) continue
    if (seen.has(entry.id)) continue
    if (!isKind(entry.kind)) continue
    if (typeof entry.name !== 'string' || !entry.name) continue
    const uuid = formatUuid(entry.uuid)
    if (!uuid) continue

    const account: StoredAccount = {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      uuid,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    }
    if (entry.authorized === false) account.authorized = false
    if (isRecord(entry.secrets)) {
      const secrets: Record<string, string> = {}
      for (const [key, value] of Object.entries(entry.secrets)) {
        if (typeof value === 'string' && value) secrets[key] = value
      }
      if (Object.keys(secrets).length > 0) account.secrets = secrets
    }
    seen.add(account.id)
    accounts.push(account)
  }
  return accounts
}

/**
 * 账户存储。
 *
 * 只负责「有哪些账户、哪一个是当前账户」与持久化；令牌加解密、登录流程
 * 都在 auth 模块里。每次写入通过 `changed` 通知调用方广播快照。
 */
export class AccountStore {
  private accounts: StoredAccount[]
  private active: string | null

  constructor(
    private readonly storage: StorageServiceApi,
    private readonly changed: () => void,
  ) {
    this.accounts = normalize(storage.get<unknown>(ACCOUNTS_KEY))
    const storedActive = storage.get<unknown>(ACTIVE_KEY)
    this.active =
      typeof storedActive === 'string' && this.accounts.some((account) => account.id === storedActive)
        ? storedActive
        : (this.accounts[0]?.id ?? null)
  }

  snapshot(): AccountSnapshot {
    return { accounts: this.accounts.map(toSummary), activeId: this.active }
  }

  list(): StoredAccount[] {
    return [...this.accounts]
  }

  get(id: string | undefined): StoredAccount | undefined {
    if (!id) return undefined
    return this.accounts.find((account) => account.id === id)
  }

  activeAccount(): StoredAccount | undefined {
    return this.get(this.active ?? undefined) ?? this.accounts[0]
  }

  /** 新增账户并返回落盘后的记录；调用方决定是否设为当前账户 */
  add(account: StoredAccount): StoredAccount {
    this.accounts = [...this.accounts, account]
    this.persist()
    return account
  }

  /** 按 id 更新；不存在时抛错，避免悄悄写出一份新记录 */
  update(id: string, patch: Partial<Omit<StoredAccount, 'id'>>): StoredAccount {
    const index = this.accounts.findIndex((account) => account.id === id)
    const current = this.accounts[index]
    if (!current) throw new Error('账户不存在，可能已被移除')
    const next: StoredAccount = { ...current, ...patch, id }
    this.accounts = this.accounts.map((account) => (account.id === id ? next : account))
    this.persist()
    return next
  }

  remove(id: string): boolean {
    const exists = this.accounts.some((account) => account.id === id)
    if (!exists) return false
    this.accounts = this.accounts.filter((account) => account.id !== id)
    if (this.active === id) this.active = this.accounts[0]?.id ?? null
    this.persist()
    return true
  }

  setActive(id: string): void {
    if (!this.accounts.some((account) => account.id === id)) {
      throw new Error('账户不存在，可能已被移除')
    }
    this.active = id
    this.persist()
  }

  private persist(): void {
    this.storage.set(ACCOUNTS_KEY, this.accounts)
    if (this.active) this.storage.set(ACTIVE_KEY, this.active)
    else this.storage.delete(ACTIVE_KEY)
    this.changed()
  }
}
