import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import { VIEW_ID } from '../shared'
import ServerStatusView from './ServerStatusView.vue'

export const name = 'mics.server-status'
export const inject = ['ui', 'ipc', 'plugins']

export function apply(ctx: Context): void {
  ctx.ui.registerView(VIEW_ID, ServerStatusView)
}

export default defineRendererPlugin({ name, inject, apply })
