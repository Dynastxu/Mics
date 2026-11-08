import type { LogEntry } from '@mics/sdk'

/**
 * 内核的日志环形缓冲。
 *
 * 两个用途：
 *   1. 启动激活完成时补发一次 `log/history`，日志插件不必读 cordis 的内部缓冲区；
 *   2. 子进程里的日志插件重启时，用最近的一段补上它错过的时间窗。
 *
 * 放成模块级而不是 `main.ts` 的局部变量，是因为 `PluginsService` 也要读它
 * （子进程插件 ready 之后要补发历史）。
 */
const LIMIT = 1024

const history: LogEntry[] = []

export function recordLogEntry(entry: LogEntry): void {
  if (history.length >= LIMIT) history.shift()
  history.push(entry)
}

/** 启动阶段补发用：取走并清空，避免与后续补发重复 */
export function drainLogHistory(): LogEntry[] {
  return history.splice(0, history.length)
}

/** 子进程插件补发用：只取最近一段，不改变缓冲 */
export function recentLogEntries(limit = 256): LogEntry[] {
  return history.slice(-limit)
}
