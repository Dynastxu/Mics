import type { Logger } from 'cordis'
import {
  CLOSE_PROMPT_DISMISS,
  CLOSE_PROMPT_REQUEST,
  isClosePromptAction,
  type ClosePromptRequest,
  type ClosePromptResponse,
  type ClosePromptResult
} from './shared'

const DEFAULT_DISPLAY_TIMEOUT_MS = 2_000
const DEFAULT_CHOICE_TIMEOUT_MS = 10 * 60_000

/** 默认调度：与宿主无关的实现，便于单测；宿主会传入 `ctx.timeout` */
function defaultSchedule(callback: () => void, delay: number): Cancel {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

export interface ClosePromptBrokerOptions {
  broadcast(topic: string, payload: unknown): void
  logger: Logger
  /**
   * 定时器工厂：默认 setTimeout，宿主传 `ctx.timeout` 让计时器随插件 fiber 回收。
   * 返回值是「取消」，替代 clearTimeout。
   */
  schedule?(callback: () => void, delay: number): () => void
  displayTimeoutMs?: number
  choiceTimeoutMs?: number
}

type Cancel = () => void

interface PendingPrompt {
  id: string
  resolve(result: ClosePromptResult | undefined): void
  displayTimer: Cancel
  choiceTimer?: Cancel
}

/**
 * 关闭确认框的主进程侧协调器。
 *
 * 只负责 request / ack / respond 的状态与超时；显示与按钮由渲染端的
 * `ConfirmDialog` 负责。界面失联时按最小化至托盘处理（结果 undefined），
 * 不会把窗口卡在「关不掉」的状态。
 */
export class ClosePromptBroker {
  private readonly pending = new Map<string, PendingPrompt>()
  private readonly displayTimeoutMs: number
  private readonly choiceTimeoutMs: number
  private readonly schedule: (callback: () => void, delay: number) => Cancel
  private sequence = 0

  constructor(private readonly options: ClosePromptBrokerOptions) {
    this.displayTimeoutMs = options.displayTimeoutMs ?? DEFAULT_DISPLAY_TIMEOUT_MS
    this.choiceTimeoutMs = options.choiceTimeoutMs ?? DEFAULT_CHOICE_TIMEOUT_MS
    this.schedule = options.schedule ?? defaultSchedule
  }

  /** 广播 request 并等待用户选择；界面没有响应时返回 undefined */
  request(): Promise<ClosePromptResult | undefined> {
    const id = `close_${++this.sequence}_${Date.now()}`
    return new Promise<ClosePromptResult | undefined>((resolve) => {
      const displayTimer = this.schedule(() => {
        const current = this.pending.get(id)
        if (!current) return
        this.options.logger.warn(
          '关闭确认框未在 %dms 内显示，按最小化至托盘处理',
          this.displayTimeoutMs
        )
        this.settle(current, undefined)
      }, this.displayTimeoutMs)

      this.pending.set(id, { id, resolve, displayTimer })
      const request: ClosePromptRequest = { id }
      this.options.broadcast(CLOSE_PROMPT_REQUEST, request)
    })
  }

  /** 渲染端确认框已显示；返回 false 表示请求已经超时，不必再显示 */
  ack(rawId: unknown): boolean {
    const id = typeof rawId === 'string' ? rawId : ''
    const prompt = this.pending.get(id)
    if (!prompt) return false

    prompt.displayTimer()
    prompt.choiceTimer?.()
    prompt.choiceTimer = this.schedule(() => {
      this.options.logger.warn('关闭确认框等待选择超时，按最小化至托盘处理')
      this.settle(prompt, undefined)
    }, this.choiceTimeoutMs)
    return true
  }

  /** 用户做出选择；请求已失效或动作不合法时抛错，由 IPC 转成错误信封 */
  respond(response: Partial<ClosePromptResponse> | undefined): void {
    const id = typeof response?.id === 'string' ? response.id : ''
    const prompt = this.pending.get(id)
    if (!prompt) throw new Error('关闭确认框已失效')
    if (!isClosePromptAction(response?.action)) throw new Error('未知的关闭行为')
    this.settle(prompt, { action: response.action, remember: response.remember === true })
  }

  /** 插件卸载 / 应用退出：所有等待中的请求按「界面失联」收尾 */
  dispose(): void {
    for (const prompt of [...this.pending.values()]) this.settle(prompt, undefined)
  }

  private settle(prompt: PendingPrompt, result: ClosePromptResult | undefined): void {
    if (this.pending.get(prompt.id) !== prompt) return
    this.pending.delete(prompt.id)
    prompt.displayTimer()
    prompt.choiceTimer?.()
    this.options.broadcast(CLOSE_PROMPT_DISMISS, { id: prompt.id })
    prompt.resolve(result)
  }
}
