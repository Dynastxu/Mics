import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ProbeView from './ProbeView.vue'

export const name = 'demo.probe-full'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('probe.full', ProbeView)
}

export default defineRendererPlugin({ name, inject, apply })
