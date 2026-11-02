import { createApp } from 'vue'
import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import CloseBehaviorSection from './CloseBehaviorSection.vue'
import ClosePromptHost from './ClosePromptHost.vue'
import { closePrompt, resetClosePrompt, setResponder } from './state'
import { CLOSE_PROMPT_DISMISS, CLOSE_PROMPT_REQUEST, type ClosePromptRequest } from '../shared'

export const name = 'mics.close-behavior'
export const inject = ['ui', 'ipc']

export function apply(ctx: Context): void {
  let active = true

  // 通用设置页的 section；props.ctx 让区块使用 close-behavior 自己的上下文
  ctx.ui.registerSettingsSection({
    id: 'close-behavior',
    title: '关闭与托盘',
    order: 20,
    component: CloseBehaviorSection,
    props: { ctx }
  })

  setResponder(async (action, remember) => {
    await ctx.ipc.invoke('mics.close-behavior', 'prompt/respond', {
      id: closePrompt.id,
      action,
      remember
    })
  })

  const offRequest = ctx.ipc.on(CLOSE_PROMPT_REQUEST, (payload) => {
    const request = payload as Partial<ClosePromptRequest> | undefined
    if (typeof request?.id !== 'string') return
    const id = request.id

    // 先 ack 再显示：主进程的显示时限已过（已经按托盘处理）时不再弹一个没人等的框
    void ctx.ipc
      .invoke<boolean>('mics.close-behavior', 'prompt/ack', { id })
      .then((accepted) => {
        if (!active || !accepted) return
        closePrompt.id = id
        closePrompt.remember = false
        closePrompt.busy = false
        closePrompt.error = ''
        closePrompt.open = true
      })
      .catch(() => {})
  })

  const offDismiss = ctx.ipc.on(CLOSE_PROMPT_DISMISS, (payload) => {
    const id = (payload as { id?: unknown } | undefined)?.id
    if (id === closePrompt.id) closePrompt.open = false
  })

  // 确认框宿主挂到 body：关闭时不一定停在设置页，不能依赖页面挂载
  const root = document.createElement('div')
  root.className = 'close-prompt-root'
  document.body.appendChild(root)
  const app = createApp(ClosePromptHost)
  app.mount(root)

  ctx.effect(() => () => {
    active = false
    offRequest()
    offDismiss()
    setResponder(undefined)
    app.unmount()
    root.remove()
    resetClosePrompt()
  })
}

export default defineRendererPlugin({ name, inject, apply })
