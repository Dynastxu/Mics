import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import GeneralSettingsView from './GeneralSettingsView.vue'
import PluginConfigurationView from './PluginConfigurationView.vue'

export const name = 'mics.settings'
export const inject = ['ui', 'theme', 'plugins', 'ipc']

export function apply(ctx: Context): void {
  ctx.ui.registerView('settings.general', GeneralSettingsView)
  ctx.ui.registerView('settings.plugins', PluginConfigurationView)
}

export default defineRendererPlugin({ name, inject, apply })
