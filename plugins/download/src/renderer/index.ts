import { h } from 'vue'
import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import { CountBadge } from '@mics/ui'
import type { InstallJobSummary } from '@mics/sdk'
import DownloadSettingsView from './DownloadSettingsView.vue'
import DownloadProgressView from './DownloadProgressView.vue'

export const name = 'mics.download'
export const inject = ['ui']

async function pendingInstallCount(): Promise<number> {
  try {
    const jobs = await window.mics.rpc.invoke<InstallJobSummary[]>(
      'mics.download.manager',
      'install/summary'
    )
    return jobs.filter((job) => !job.finished).length
  } catch {
    return 0
  }
}

export function apply(ctx: Context): void {
  ctx.ui.registerView('settings.download', DownloadSettingsView)
  ctx.ui.registerView('download.progress', DownloadProgressView)
  ctx.ui.registerView('download.badge', () => h(CountBadge, { resolve: pendingInstallCount }))
}

export default defineRendererPlugin({ name, inject, apply })