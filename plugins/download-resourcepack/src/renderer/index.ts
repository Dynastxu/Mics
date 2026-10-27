import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ResourcepackView from './ResourcepackView.vue'

export const name = 'mics.download.resourcepack'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.resourcepack', ResourcepackView)
}

export default defineRendererPlugin({ name, inject, apply })
