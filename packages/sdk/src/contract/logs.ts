import type { Context } from 'cordis'
import { pluginIdOf } from './services'

/**
 * 日志的共享契约。
 *
 * 日志不是服务：主进程插件直接用 cordis 的 `ctx.logger(...)`，渲染进程插件用
 * `writeLog()` 发出 `ipc:log/write` 事件，`mics.logger` 只是这些输出的可选观察者。
 * 禁用日志插件不会让任何插件停在等待服务的状态。
 */

/** 日志级别，从低到高 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 级别白名单：跨进程写入与设置校验共用，避免拼错的级别落进日志文件 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** 运行时校验任意值是不是合法日志级别 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

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

/** 日志插件设置 */
export interface LogSettings {
  /** 保留的日志文件个数（1–50） */
  maxFiles: number
}

/**
 * 一条日志事件。
 *
 * 内核把 cordis 的 `ctx.logger(...)` 输出转成这类事件派发出去，日志插件只是
 * 订阅者——它不需要访问 cordis 的内部缓冲区，也不需要 `electron`。
 */
export interface LogEntry {
  /** 单调递增序号；补录与去重都靠它 */
  sn: number
  ts: number
  type: LogLevel
  /** 作用域（通常是插件 id） */
  name: string
  /** 沿用 cordis 的 `%s` / `%d` / `%o` 参数形态 */
  args: unknown[]
}

/** 设置页读取的日志状态 */
export interface LogStatus extends LogSettings {
  directory: string
  /** 本次启动正在写入的文件 */
  file: string
}

/**
 * 写入主进程日志的请求（事件：`ipc:log/write`）。
 *
 * 渲染进程没有文件系统权限，日志统一交给主进程落盘；作用域由 `writeLog()`
 * 自动取调用方插件 id，也可以显式传入。
 */
export interface LogWriteRequest {
  level: LogLevel
  /** 沿用 cordis 的 `%s` / `%d` / `%o` 参数形态 */
  args: unknown[]
  /** 日志行里的来源标签；缺省由 logger 插件退回 `renderer` */
  scope?: string
}

declare module 'cordis' {
  interface Events {
    /**
     * 写日志请求。
     *
     * `mics.logger` 订阅这个事件；插件被禁用时没有监听者，事件自然丢弃，
     * 调用方不会因此失败或等待。
     */
    'ipc:log/write'(request: LogWriteRequest): void

    /** 内核产生的一条日志（`ctx.logger` 的输出） */
    'log/entry'(entry: LogEntry): void

    /**
     * 启动阶段的历史日志。
     *
     * 内核在启动插件激活完成后派发一次，让日志插件不必去读 cordis 的内部缓冲区；
     * 订阅得晚的插件也能补齐启动过程。
     */
    'log/history'(entries: LogEntry[]): void
  }
}

/**
 * 通过事件写一条日志。
 *
 * 不要求调用方注入日志服务：主进程插件也可以直接使用 cordis 的
 * `ctx.logger(...)`，它会由 `mics.logger` 的导出器写入文件。
 */
export function writeLog(
  ctx: Context,
  level: LogLevel,
  message: unknown,
  ...args: unknown[]
): void {
  ctx.ipc.emit('ipc:log/write', {
    level,
    args: [message, ...args],
    scope: pluginIdOf(ctx)
  })
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
  fallback: number = DEFAULT_LOG_MAX_FILES
): number {
  if (value === null || value === undefined) return fallback
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_LOG_MAX_FILES, Math.max(MIN_LOG_MAX_FILES, Math.round(parsed)))
}
