import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import VanillaView from './VanillaView.vue'

export const name = 'mics.download.vanilla'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.vanilla', VanillaView)
}

export default defineRendererPlugin({ name, inject, apply })
