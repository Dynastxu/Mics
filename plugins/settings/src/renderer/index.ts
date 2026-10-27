import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import GeneralSettingsView from './GeneralSettingsView.vue'

export const name = 'mics.settings'
export const inject = ['ui', 'theme', 'plugins']

export function apply(ctx: Context): void {
  ctx.ui.registerView('settings.general', GeneralSettingsView)
}

export default defineRendererPlugin({ name, inject, apply })
