import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import DatapackView from './DatapackView.vue'

export const name = 'mics.download.datapack'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.datapack', DatapackView)
}

export default defineRendererPlugin({ name, inject, apply })
