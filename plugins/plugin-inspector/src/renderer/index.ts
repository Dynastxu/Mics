import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import InspectorView from './InspectorView.vue'

export const name = 'mics.plugin-inspector'
export const inject = ['ui', 'plugins']

export function apply(ctx: Context): void {
  ctx.ui.registerView('inspector.view', InspectorView)
}

export default defineRendererPlugin({ name, inject, apply })
