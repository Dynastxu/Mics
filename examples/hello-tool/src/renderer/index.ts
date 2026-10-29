import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import HelloView from './HelloView.vue'

export const name = 'demo.hello-tool'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('hello.view', HelloView)
}

export default defineRendererPlugin({ name, inject, apply })
