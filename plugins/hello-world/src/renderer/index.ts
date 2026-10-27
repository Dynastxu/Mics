import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import HelloView from './HelloView.vue'

export const name = 'mics.hello-world'
export const inject = ['ui', 'ipc', 'commands']

export function apply(ctx: Context): void {
  ctx.ui.registerView('hello.view', HelloView)
  ctx.ui.registerStatusBarItem({
    id: 'hello.runtime-status',
    text: 'Hello 运行时',
    alignment: 'right',
    order: 20,
    command: 'hello.greet',
  })
}

export default defineRendererPlugin({ name, inject, apply })
