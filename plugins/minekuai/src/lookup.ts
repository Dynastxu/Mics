import type { CatalogDescriptor, ModProjectKind } from '@mics/sdk'
import { queryMineKuai } from './api'
import type { MineKuaiItem } from './api'
import { TtlCache } from './cache'
import { translateFromCandidates } from './match'
import type { CatalogTranslation } from './match'
import type { MineKuaiSettings } from './settings'

/**
 * 麦块查询与匹配。
 *
 * 一次目录响应可能同时带来 20 个条目，全部串行会拖慢首屏，全部并发又容易
 * 撞上公共接口的限流。这里做三件事：
 *
 * - 同一批（120ms 窗口内）到达的查询共享一个 `budgetMs` 截止时间，超时的
 *   条目直接回退原文，不再把整页拖住；
 * - 用信号量限制并发，并发数来自设置；
 * - 查询结果与最终匹配都按 `cacheTtlMinutes` 缓存，设置变化（baseUrl、候选
 *   数量）会自然形成新的缓存键。
 */

type LookupLogger = {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
}

interface CandidateResult {
  items: MineKuaiItem[]
  /** 查询是否真正成功；网络失败不能写成负缓存 */
  ok: boolean
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    await this.acquire(limit)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(limit: number): Promise<void> {
    if (this.active < Math.max(1, limit)) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    // 名额直接转交给下一个等待者；先减再加会让新调用者插队，突破并发上限
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}

export interface LookupStats {
  translations: number
  queries: number
  failures: number
  circuitOpen: boolean
}

export class MineKuaiLookup {
  private readonly translations = new TtlCache<CatalogTranslation | null>(1024)
  private readonly queries = new TtlCache<MineKuaiItem[]>(256)
  private readonly inFlight = new Map<string, Promise<CandidateResult>>()
  private readonly semaphore = new Semaphore()
  private batchAt = 0
  private batchDeadline = 0
  private failures = 0
  private circuitUntil = 0

  constructor(
    private readonly settings: () => MineKuaiSettings,
    private readonly log: LookupLogger
  ) {}

  /** 解析单个目录条目的译文；未命中或失败返回 null，调用方保留原文 */
  async resolve(descriptor: CatalogDescriptor): Promise<CatalogTranslation | null> {
    const settings = this.settings()
    if (!descriptor.name.trim()) return null

    const key = this.translationKey(settings, descriptor)
    const cached = this.translations.get(key)
    if (cached !== undefined) return cached

    const deadline = this.deadlineFor(settings)
    return this.semaphore.run(settings.concurrency, async () => {
      const result = await this.candidates(settings, descriptor.kind, descriptor.name, deadline)
      if (!result.ok) return null
      const translation = translateFromCandidates(descriptor, result.items)
      this.translations.set(key, translation, this.ttl(settings))
      return translation
    })
  }

  /** 暴露给 RPC 的原始查询：返回英文与中文并存的条目，不做匹配 */
  async search(kind: ModProjectKind, query: string): Promise<MineKuaiItem[]> {
    const settings = this.settings()
    return this.semaphore.run(settings.concurrency, async () => {
      const deadline = Date.now() + settings.timeoutMs
      const result = await this.candidates(settings, kind, query, deadline)
      return result.items
    })
  }

  stats(): LookupStats {
    return {
      translations: this.translations.size,
      queries: this.queries.size,
      failures: this.failures,
      circuitOpen: this.circuitOpen()
    }
  }

  clear(): void {
    this.translations.clear()
    this.queries.clear()
    this.failures = 0
    this.circuitUntil = 0
  }

  private ttl(settings: MineKuaiSettings): number {
    return settings.cacheTtlMinutes * 60_000
  }

  /**
   * 连续失败后短暂熔断。
   *
   * 接口不可达时，每个目录条目都等满超时会把整页拖住；连续 3 次失败后
   * 暂停查询 60 秒，期间直接回退原文，恢复后再放一次探测。
   */
  private circuitOpen(): boolean {
    return Date.now() < this.circuitUntil
  }

  private recordFailure(): void {
    this.failures += 1
    if (this.failures < 3 || this.circuitOpen()) return
    this.circuitUntil = Date.now() + 60_000
    this.log.warn('麦块 API 连续失败 %d 次，暂停查询 60 秒', this.failures)
  }

  private recordSuccess(): void {
    if (this.failures >= 3) this.log.info('麦块 API 已恢复')
    this.failures = 0
    this.circuitUntil = 0
  }

  /**
   * 同一批并发查询共享截止时间。
   *
   * 下载管线用 `Promise.all` 同时派发多条 `catalog/describe`，这些调用几乎
   * 同时到达；用 120ms 窗口把它们归成一批，避免每条各等一个 budgetMs。
   */
  private deadlineFor(settings: MineKuaiSettings): number {
    const now = Date.now()
    if (now - this.batchAt > 120) {
      this.batchAt = now
      this.batchDeadline = now + settings.budgetMs
    }
    return this.batchDeadline
  }

  private translationKey(settings: MineKuaiSettings, descriptor: CatalogDescriptor): string {
    return [
      settings.baseUrl,
      settings.maxCandidates,
      descriptor.kind,
      descriptor.projectId,
      descriptor.name,
      descriptor.summary
    ].join('|')
  }

  private queryKey(settings: MineKuaiSettings, kind: ModProjectKind, query: string): string {
    return [settings.baseUrl, kind, settings.maxCandidates, query.trim()].join('|')
  }

  private async candidates(
    settings: MineKuaiSettings,
    kind: ModProjectKind,
    query: string,
    deadline: number
  ): Promise<CandidateResult> {
    const key = this.queryKey(settings, kind, query)
    const cached = this.queries.get(key)
    if (cached !== undefined) return { items: cached, ok: true }
    if (this.circuitOpen()) return { items: [], ok: false }

    // 同一个名称可能同时出现在搜索结果与多个版本的依赖里，复用同一个请求
    const running = this.inFlight.get(key)
    if (running) return running
    const task = this.fetchCandidates(settings, kind, query, key, deadline).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  private async fetchCandidates(
    settings: MineKuaiSettings,
    kind: ModProjectKind,
    query: string,
    key: string,
    deadline: number
  ): Promise<CandidateResult> {
    const remaining = Math.min(settings.timeoutMs, deadline - Date.now())
    if (remaining <= 0) return { items: [], ok: false }
    const signal = AbortSignal.timeout(remaining)
    try {
      const items = await queryMineKuai(settings, kind, query, signal)
      this.queries.set(key, items, this.ttl(settings))
      this.recordSuccess()
      return { items, ok: true }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.log.debug('麦块查询失败：%s', message)
      // 目录等待预算用尽（或单次超时）不是接口故障，不能因此熔断
      const aborted =
        signal.aborted ||
        (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError'))
      if (!aborted) this.recordFailure()
      return { items: [], ok: false }
    }
  }
}
