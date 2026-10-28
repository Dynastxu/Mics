import path from 'node:path'
import { app, shell } from 'electron'
import type { Context } from 'cordis'
import type { LogStatus } from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import { LogsService } from './service'
import { readLogSettings, writeLogSettings } from './settings'

export const name = 'mics.logger'
export const inject = ['ipc', 'storage']

/**
 * 日志插件（主进程）。
 *
 * - 提供 `ctx.logs` 服务，其它插件用 `inject: ['logs']` 调用；
 * - 每次启动创建一个日志文件，保留数量由设置页控制（默认 5）；
 * - 同时把 cordis 的 `ctx.logger(...)` 输出写入同一个文件，
 *   因此内核与已有插件不需要改代码就能被记录。
 */
export function apply(ctx: Context): void {
  const directory = path.join(app.getPath('userData'), 'logs')
  const logs = new LogsService(ctx, {
    directory,
    maxFiles: readLogSettings(ctx.storage).maxFiles,
  })

  logs.scope(name).info(
    'MICS %s 启动 · Electron %s · %s',
    app.getVersion(),
    process.versions.electron ?? '-',
    process.platform,
  )
  logs.scope(name).info('日志文件 %s（保留 %d 个）', logs.file, logs.maxFiles)

  // 已有代码统一走 ctx.logger；把它接进文件，避免为了日志改造每个插件
  ctx.logger.exporter({
    colors: false,
    export: (message) => {
      logs.record(message.type, message.name, message.args, message.ts)
    },
  })

  const status = (): LogStatus => logs.status()

  ctx.ipc.handle('settings/get', status)

  ctx.ipc.handle<{ maxFiles?: unknown } | undefined>('settings/set', (params) => {
    const next = writeLogSettings(ctx.storage, params?.maxFiles)
    logs.setMaxFiles(next)
    logs.scope(name).info('保留数量调整为 %d', next)
    return status()
  })

  ctx.ipc.handle('directory/open', async () => {
    const error = await shell.openPath(logs.directory)
    if (error) throw new Error(error)
  })
}

export default defineMainPlugin({ name, inject, apply })
