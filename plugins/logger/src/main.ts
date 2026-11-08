import path from 'node:path'
import { format as utilFormat } from 'node:util'
import type { Context } from 'cordis'
import type { LogStatus, LogWriteRequest } from '@mics/sdk'
import { isLogLevel } from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import { LogSink } from './sink'
import { LogWriter } from './writer'
import { readLogSettings, writeLogSettings } from './settings'

export const name = 'mics.logger'
export const inject = ['ipc', 'storage', 'host']

/** 进程级状态：插件重载时复用，避免每次 apply 都新开一个日志文件 */
const SINK_KEY = Symbol.for('mics.logger.sink')

function processState<T>(key: symbol, create: () => T): T {
  const globals = globalThis as unknown as Record<symbol, T | undefined>
  return (globals[key] ??= create())
}

function acquireSink(directory: string): LogSink {
  return processState(SINK_KEY, () => new LogSink(directory))
}

function writeRendererLog(
  logs: LogWriter,
  request: LogWriteRequest | undefined,
  scope: string | undefined,
  isDev: boolean
): void {
  const level = isLogLevel(request?.level) ? request.level : 'info'
  // 参数来自渲染进程：只接受有限数量，避免一次 RPC 把日志文件撑爆
  const args = Array.isArray(request?.args) ? request.args.slice(0, 32) : [request ?? '']
  logs.record(level, scope ?? 'renderer', args, Date.now())
  // 渲染端日志不经过 ctx.logger，开发构建在终端补一行，否则排查启动问题时只能翻日志文件
  if (isDev && level !== 'debug') {
    const label = `[renderer:${scope ?? 'renderer'}]`
    // 与 ctx.logger 一致：支持 %s / %d / %o 占位符
    const line = `${label} ${utilFormat(args[0] as string, ...args.slice(1))}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  }
}

/**
 * 日志插件。
 *
 * 它是一个**纯事件接收器**：内核把 cordis 的 `ctx.logger(...)` 输出转成
 * `log/entry` 事件，启动阶段的历史通过 `log/history` 补发，渲染进程经
 * `ipc:log/write` 汇总过来。三类来源都只是事件，没有任何一种要求它住在主进程
 * 或读 cordis 的内部缓冲区。
 *
 * 因此它可以被禁用：没有订阅者时事件自然丢弃，调用方不会失败。
 */
export function apply(ctx: Context): void {
  const directory = path.join(ctx.host.paths.userData, 'logs')
  const isDev = ctx.host.app.isDev
  const logs = new LogWriter({
    sink: acquireSink(directory),
    maxFiles: readLogSettings(ctx.storage).maxFiles
  })

  // 实时日志：来自内核的日志事件桥
  ctx.on('log/entry', (entry) => {
    logs.record(entry.type, entry.name, entry.args, entry.ts)
  })

  // 启动阶段的历史：内核在启动插件激活完成后补发一次
  ctx.on('log/history', (entries) => {
    const count = logs.importHistory(entries)
    if (count > 0) logs.scope(name).info('已补录启动阶段日志 %d 条', count)
  })

  logs
    .scope(name)
    .info(
      '日志服务就绪：MICS %s · Electron %s · Chrome %s · Node %s · %s/%s',
      ctx.host.app.version,
      process.versions.electron ?? '-',
      process.versions.chrome ?? '-',
      process.versions.node,
      process.platform,
      process.arch
    )
  logs.scope(name).info('日志文件 %s（保留 %d 个）', logs.file, logs.maxFiles)

  // 渲染进程没有文件系统权限：日志经 `ipc:log/write` 事件汇总到主进程
  ctx.on('ipc:log/write', (request) => {
    writeRendererLog(logs, request, request.scope, isDev)
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
    logs.scope(name).info('打开日志目录 %s', logs.directory)
    const error = await ctx.host.shell.openPath(logs.directory)
    if (error) {
      logs.scope(name).error('打开日志目录失败：%s', error)
      throw new Error(error)
    }
  })
}

export default defineMainPlugin({ name, inject, apply })
