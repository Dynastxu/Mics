import { h } from 'vue'
import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import { CountBadge } from '@mics/ui'
import LaunchView from './LaunchView.vue'
import LaunchSettingsView from './LaunchSettingsView.vue'
import type { LaunchState } from '../shared'

export const name = 'mics.launch'
export const inject = ['ui', 'ipc']

async function runningInstanceCount(): Promise<number> {
  try {
    const state = await window.mics.rpc.invoke<LaunchState>('mics.launch', 'instances/state')
    return state.instances.filter((ins) =>
      ins.processes.some((proc) => proc.phase === 'running')
    ).length
  } catch {
    return 0
  }
}

export function apply(ctx: Context): void {
  ctx.ui.registerView('launch', LaunchView)
  ctx.ui.registerView('settings.launch', LaunchSettingsView)
  ctx.ui.registerView('launch.badge', () => h(CountBadge, { resolve: runningInstanceCount }))
}

export default defineRendererPlugin({ name, inject, apply })