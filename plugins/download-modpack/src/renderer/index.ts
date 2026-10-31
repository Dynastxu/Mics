import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ModpackView from './ModpackView.vue'

export const name = 'mics.download.modpack'
export const inject = ['ui', 'plugins', 'notifications']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.modpack', ModpackView)
}

export default defineRendererPlugin({ name, inject, apply })
