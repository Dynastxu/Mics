import path from 'node:path'
import { app, shell } from 'electron'
import type { Context, Message } from 'cordis'
import type { LogLevel, LogStatus, LogWriteRequest } from '@mics/sdk'
import { isLogLevel } from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import { LogSink } from './sink'
import { LogsService } from './service'
import { readLogSettings, writeLogSettings } from './settings'

export const name = 'mics.logger'
export const inject = ['ipc', 'storage']

/** 进程级状态：插件重载时复用，避免每次 apply 都新开一个日志文件 */
const SINK_KEY = Symbol.for('mics.logger.sink')
/** 已写入文件的最大消息序号；用来只补录「导出器没装上」的那一段 */
const CURSOR_KEY = Symbol.for('mics.logger.cursor')

// cordis logger 缓冲区最多保留 1000 条，补录是尽力而为

interface LoggerBuffer {
  buffer?: Message[]
}

interface HistoryCursor {
  sn: number
}

function processState<T>(key: symbol, create: () => T): T {
  const globals = globalThis as unknown as Record<symbol, T | undefined>
  return (globals[key] ??= create())
}

function acquireSink(directory: string): LogSink {
  return processState(SINK_KEY, () => new LogSink(directory))
}

function historyCursor(): HistoryCursor {
  return processState(CURSOR_KEY, () => ({ sn: 0 }))
}

function readBuffer(ctx: Context): Message[] {
  return (ctx.logger as unknown as LoggerBuffer).buffer ?? []
}

/** 开发模式下把日志同时打印到控制台；debug 只进文件，避免刷屏 */
function mirrorToConsole(level: LogLevel, scope: string, text: string): void {
  if (level === 'debug') return
  const line = `${level.toUpperCase().padEnd(5)} [${scope}] ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

function writeRendererLog(
  logs: LogsService,
  request: LogWriteRequest | undefined,
  callerId: string | undefined,
): void {
  const level = isLogLevel(request?.level) ? request.level : 'info'
  // 参数来自渲染进程：只接受有限数量，避免一次 RPC 把日志文件撑爆
  const args = Array.isArray(request?.args) ? request.args.slice(0, 32) : [request ?? '']
  logs.record(level, callerId ?? 'renderer', args, Date.now())
}

/**
 * 日志插件（主进程）。
 *
 * - 提供 `ctx.logs` 服务，其它插件用 `inject: ['logs']` 调用；
 * - 每次启动创建一个日志文件，保留数量由设置页控制（默认 5）；
 * - 同时把 cordis 的 `ctx.logger(...)` 输出写入同一个文件，
 *   因此内核与已有插件不需要改代码就能被记录；
 * - 启动早于本插件的日志从 cordis 缓冲区补录，渲染进程的日志经 RPC 汇总。
 */
export function apply(ctx: Context): void {
  const directory = path.join(app.getPath('userData'), 'logs')
  const logs = new LogsService(ctx, {
    sink: acquireSink(directory),
    maxFiles: readLogSettings(ctx.storage).maxFiles,
    // 控制台镜像只在开发构建启用：生产环境没有终端可看
    mirror: app.isPackaged ? undefined : mirrorToConsole,
  })

  // 先回放历史，再安装导出器：这样启动阶段的日志不会被写第二次
  const cursor = historyCursor()
  const pending = readBuffer(ctx).filter((message) => message.sn > cursor.sn)
  const replayed = logs.importHistory(pending)
  const latest = pending.at(-1)
  if (latest) cursor.sn = latest.sn

  logs.scope(name).info(
    '日志服务就绪：MICS %s · Electron %s · Chrome %s · Node %s · %s/%s',
    app.getVersion(),
    process.versions.electron ?? '-',
    process.versions.chrome ?? '-',
    process.versions.node,
    process.platform,
    process.arch,
  )
  logs.scope(name).info('日志文件 %s（保留 %d 个）', logs.file, logs.maxFiles)
  if (replayed > 0) logs.scope(name).info('已补录启动阶段日志 %d 条', replayed)

  // 已有代码统一走 ctx.logger；把它接进文件，避免为了日志改造每个插件。
  // levels.default = 3：文件里保留 debug，排查问题时不被默认级别过滤掉。
  ctx.logger.exporter({
    colors: false,
    levels: { default: 3 },
    export: (message) => {
      cursor.sn = message.sn
      logs.record(message.type, message.name, message.args, message.ts)
    },
  })

  // 渲染进程没有文件系统权限：日志经这条 RPC 汇总到主进程写入同一文件；
  // 作用域优先取调用方插件 id（与 IPC callerId 一样是尽力而为的标识）
  ctx.ipc.handle<LogWriteRequest>('log/write', (request, meta) => {
    writeRendererLog(logs, request, meta.callerId)
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
    const error = await shell.openPath(logs.directory)
    if (error) {
      logs.scope(name).error('打开日志目录失败：%s', error)
      throw new Error(error)
    }
  })
}

export default defineMainPlugin({ name, inject, apply })
