import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import LaunchView from './LaunchView.vue'
import LaunchSettingsView from './LaunchSettingsView.vue'

export const name = 'mics.launch'
export const inject = ['ui', 'ipc']

export function apply(ctx: Context): void {
  ctx.ui.registerView('launch', LaunchView)
  ctx.ui.registerView('settings.launch', LaunchSettingsView)
}

export default defineRendererPlugin({ name, inject, apply })
