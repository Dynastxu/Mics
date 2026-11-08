import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import ProbeView from './ProbeView.vue'

export const name = 'demo.probe-sandboxed'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('probe.sandboxed', ProbeView)
}

export default defineRendererPlugin({ name, inject, apply })
