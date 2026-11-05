/**
 * 进程内 TTL 缓存。
 *
 * 译文和候选列表都是「读多写少」：同一批目录在翻页、返回详情、切换筛选时
 * 会反复出现。缓存只存在内存里，不写 userData，避免把第三方译名当成用户
 * 数据；插件重载或重启后重新查询。
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>()

  constructor(private readonly limit = 512) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // 刷新 LRU 顺序：Map 的迭代顺序就是插入顺序
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key)
    this.entries.set(key, { expiresAt: Date.now() + Math.max(0, ttlMs), value })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
