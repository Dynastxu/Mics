import type { LogLevel } from '@mics/sdk'

/**
 * 渲染进程的日志出口。
 *
 * 渲染进程没有文件系统权限：真正的落盘由主进程的 `mics.logger` 完成。
 * 这里只保留一个可替换的出口（由 boot() 注入到主进程的 RPC），
 * 主进程日志服务尚未就绪时退回控制台，保证日志不会丢得无声无息。
 */
export type RendererLogSink = (level: LogLevel, args: unknown[]) => void

let sink: RendererLogSink | undefined

export function installLogSink(next: RendererLogSink): void {
  sink = next
}

export function logDebug(message: unknown, ...args: unknown[]): void {
  write('debug', [message, ...args])
}

export function logInfo(message: unknown, ...args: unknown[]): void {
  write('info', [message, ...args])
}

export function logWarn(message: unknown, ...args: unknown[]): void {
  write('warn', [message, ...args])
}

export function logError(message: unknown, ...args: unknown[]): void {
  write('error', [message, ...args])
}

function write(level: LogLevel, args: unknown[]): void {
  if (sink) {
    try {
      sink(level, args)
      return
    } catch {
      // 出口暂时不可用（主进程还在启动）：继续走控制台兜底
    }
  }
  if (level === 'error') console.error(...args)
  else if (level === 'warn') console.warn(...args)
  else if (level === 'debug') console.debug(...args)
  else console.info(...args)
}
