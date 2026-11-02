import { reactive } from 'vue'
import type { ClosePromptAction } from '../shared'

/**
 * 关闭确认框状态。
 *
 * 和通知宿主一样是模块级状态：主进程的 request 事件只改这里，宿主组件负责绘制，
 * 两者都不依赖 cordis 服务，插件被停用时随宿主一起清理。
 */
export interface ClosePromptState {
  open: boolean
  /** 当前请求 id；respond / dismiss 都按它对账 */
  id: string
  remember: boolean
  busy: boolean
  error: string
}

const initial = (): ClosePromptState => ({
  open: false,
  id: '',
  remember: false,
  busy: false,
  error: ''
})

export const closePrompt = reactive<ClosePromptState>(initial())

export function resetClosePrompt(): void {
  Object.assign(closePrompt, initial())
}

type Responder = (action: ClosePromptAction, remember: boolean) => Promise<void>

let responder: Responder | undefined

export function setResponder(next: Responder | undefined): void {
  responder = next
}

/** 用户做出选择：把结果交给主进程；失败时留在对话框里显示原因 */
export async function respondClosePrompt(action: ClosePromptAction): Promise<void> {
  if (!closePrompt.open || closePrompt.busy || !responder) return

  closePrompt.busy = true
  closePrompt.error = ''
  try {
    await responder(action, closePrompt.remember)
    closePrompt.open = false
  } catch (error) {
    // 插件在等待期间被停用时宿主已经卸载，不要把错误写回下一次激活
    if (closePrompt.open) {
      closePrompt.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    closePrompt.busy = false
  }
}
