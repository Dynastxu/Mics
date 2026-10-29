import type { Exporter, Message } from 'cordis'
import { Logger } from 'cordis'
import type { LogLevel } from '@mics/sdk'

/** 只用来复用 cordis 的格式化能力；日志文件不需要 ANSI 颜色 */
const FORMATTER: Exporter = {
  colors: false,
  export() {},
}

/**
 * 把 `info(fmt, ...args)` 归一化成一行正文。
 *
 * 复用 cordis Logger.format：支持 `%s` / `%d` / `%o`，Error 记录堆栈，
 * 对象转 JSON。格式化失败时退回朴素拼接——写日志绝不能抛错。
 */
export function formatArgs(args: unknown[]): string {
  const normalized = args.map(normalizeErrorArg)
  // 第一个参数是 Error 时 cordis 会自己插入 %s；这里已经换成堆栈字符串，
  // 补回占位符，避免把堆栈里的 % 当成格式指令。
  if (args[0] instanceof Error) normalized.unshift('%s')

  const message: Message = {
    sn: 0,
    ts: Date.now(),
    name: 'mics',
    type: 'info',
    level: 2,
    args: normalized,
  }
  try {
    return Logger.format(FORMATTER, message)
  } catch {
    return normalized.map(fallback).join(' ')
  }
}

/** 任意位置的 Error 都转成堆栈字符串；否则 `%o` 的 JSON.stringify 只会得到 {} */
function normalizeErrorArg(value: unknown): unknown {
  if (!(value instanceof Error)) return value
  return value.stack ?? `${value.name}: ${value.message}`
}

/** 一行日志：本地时间（带时区） + 级别 + 来源 + 正文；多行正文缩进续行 */
export function formatLine(level: LogLevel, scope: string, text: string, ts: number): string {
  const head = `${timestamp(ts)} ${level.toUpperCase().padEnd(5)} [${scope}] `
  return `${head}${text.replace(/\r?\n/g, '\n    ')}\n`
}

/** 本地 ISO 时间，例如 2026-05-09T20:30:00.123+08:00 */
function timestamp(ts: number): string {
  const date = new Date(Number.isFinite(ts) ? ts : Date.now())
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  const time = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  ].join('T')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${time}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function fallback(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
}
