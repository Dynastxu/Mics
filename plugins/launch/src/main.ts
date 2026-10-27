import { app } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { listInstances, markInstanceLaunched, resolveInstance } from './instances'
import { launchInstance } from './launch'
import type { LaunchRequest, LaunchResult } from './shared'

export const name = 'mics.launch'
export const inject = ['ipc', 'storage']

function sanitizeUsername(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  return name ? name.slice(0, 16) : 'Steve'
}

export function apply(ctx: Context): void {
  const dataDir = app.getPath('userData')

  ctx.ipc.handle('instances/list', () => listInstances(dataDir))

  ctx.ipc.handle('account/get', () => ({
    username: sanitizeUsername(ctx.storage.get<string>('username', 'Steve')),
  }))

  ctx.ipc.handle<{ username: string }>('account/set', ({ username }) => {
    const name = sanitizeUsername(username)
    ctx.storage.set('username', name)
    return { username: name }
  })

  ctx.ipc.handle<LaunchRequest>('instances/launch', async ({ id, username }) => {
    const instance = resolveInstance(dataDir, id)
    if (!instance) throw new Error('实例不存在或缺少版本文件')

    const name = sanitizeUsername(username || ctx.storage.get<string>('username', 'Steve'))
    const memory = Number(ctx.storage.get<string>('maxMemory', '4096'))

    const pid = await launchInstance(instance, {
      username: name,
      launcherVersion: app.getVersion(),
      memoryMb: Number.isFinite(memory) ? memory : 4096,
    })
    markInstanceLaunched(instance, name)

    return { pid } satisfies LaunchResult
  })
}

export default defineMainPlugin({ name, inject, apply })
