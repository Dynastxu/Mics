/**
 * 日志服务的共享契约。
 *
 * `mics.logger` 插件在主进程提供 `ctx.logs`，其它插件通过 `inject: ['logs']` 使用。
 * 日志按「每次启动一个文件」写入 `<userData>/logs`，保留数量可在设置中调整。
 */

/** 日志级别，从低到高 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 一个作用域的写日志入口。
 *
 * `scope` 只是日志行里的来源标签；正文沿用 cordis 的 `%s` / `%d` / `%o` 占位符，
 * 传 `Error` 时记录堆栈。
 */
export interface LogScope {
  debug(message: unknown, ...args: unknown[]): void
  info(message: unknown, ...args: unknown[]): void
  warn(message: unknown, ...args: unknown[]): void
  error(message: unknown, ...args: unknown[]): void
}

/**
 * 主进程日志服务。
 *
 * 直接调用时作用域自动取调用方插件 id；需要固定标签时先用 `scope(name)`。
 */
export interface LogsServiceApi extends LogScope {
  /** 显式指定作用域；调用方插件 id 不再参与 */
  scope(name: string): LogScope
  /** 本次启动对应的日志文件绝对路径 */
  readonly file: string
  /** 日志目录绝对路径 */
  readonly directory: string
}

/** 日志插件设置 */
export interface LogSettings {
  /** 保留的日志文件个数（1–50） */
  maxFiles: number
}

/** 设置页读取的日志状态 */
export interface LogStatus extends LogSettings {
  directory: string
  /** 本次启动正在写入的文件 */
  file: string
}

/** 默认保留最近 5 个日志文件（含本次启动的文件） */
export const DEFAULT_LOG_MAX_FILES = 5
export const MIN_LOG_MAX_FILES = 1
export const MAX_LOG_MAX_FILES = 50

/**
 * 把任意输入归一化成合法的保留数量。
 *
 * 空值 / 非数字退回 `fallback`，其余夹到 1–50 并取整；
 * 主进程与设置页共用同一套规则，避免两边保存出不同的值。
 */
export function normalizeLogMaxFiles(
  value: unknown,
  fallback: number = DEFAULT_LOG_MAX_FILES,
): number {
  if (value === null || value === undefined) return fallback
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_LOG_MAX_FILES, Math.max(MIN_LOG_MAX_FILES, Math.round(parsed)))
}
