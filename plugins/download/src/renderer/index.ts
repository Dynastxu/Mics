import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import DownloadSettingsView from './DownloadSettingsView.vue'

export const name = 'mics.download'
export const inject = ['ui']

export function apply(ctx: Context): void {
  ctx.ui.registerView('settings.download', DownloadSettingsView)
}

export default defineRendererPlugin({ name, inject, apply })
