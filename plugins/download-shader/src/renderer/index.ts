import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ShaderView from './ShaderView.vue'

export const name = 'mics.download.shader'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('download.shader', ShaderView)
}

export default defineRendererPlugin({ name, inject, apply })
