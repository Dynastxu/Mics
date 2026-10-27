import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ModView from './ModView.vue'

export const name = 'mics.download.mod'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.mod', ModView)
}

export default defineRendererPlugin({ name, inject, apply })
