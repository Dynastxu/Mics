import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import LoggerSettingsView from './LoggerSettingsView.vue'

export const name = 'mics.logger'
export const inject = ['ui', 'ipc']

export function apply(ctx: Context): void {
  ctx.ui.registerView('settings.logger', LoggerSettingsView)
}

export default defineRendererPlugin({ name, inject, apply })
