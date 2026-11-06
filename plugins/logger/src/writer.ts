import type { LogLevel, LogScope, LogStatus } from '@mics/sdk'
import { normalizeLogMaxFiles } from '@mics/sdk'
import { formatArgs, formatLine } from './format'
import { LogSink } from './sink'

export interface LogWriterOptions {
  /** 进程内共享的写入端：插件重载时复用同一个文件，而不是再开一份 */
  sink: LogSink
  maxFiles: number
  /** 每写一行回调一次；开发模式下用于同时输出到控制台 */
  mirror?: (level: LogLevel, scope: string, text: string) => void
}

/** 一条已经产生、但日志插件尚未就绪的历史消息（来自 cordis logger 缓冲区） */
export interface LogHistoryEntry {
  ts: number
  name: string
  type: LogLevel
  args: unknown[]
}

const DEFAULT_SCOPE = 'mics'
const MAX_SCOPE_LENGTH = 48

/**
 * 日志文件的写入端。
 *
 * 它不是 cordis 服务：主进程插件用 `ctx.logger(...)` 输出，渲染进程插件用
 * `writeLog()` 发出事件，`mics.logger` 只负责订阅这些来源并落盘。因此日志
 * 插件可以被禁用而不影响任何调用方。
 */
export class LogWriter {
  private readonly sink: LogSink
  private readonly mirror?: LogWriterOptions['mirror']
  private limit: number

  constructor(options: LogWriterOptions) {
    this.limit = normalizeLogMaxFiles(options.maxFiles)
    this.sink = options.sink
    this.mirror = options.mirror
    this.sink.prune(this.limit)
  }

  get file(): string {
    return this.sink.file
  }

  get directory(): string {
    return this.sink.directory
  }

  get maxFiles(): number {
    return this.limit
  }

  scope(name: string): LogScope {
    const label = scopeLabel(name)
    return {
      debug: (message, ...args) => this.write('debug', label, [message, ...args]),
      info: (message, ...args) => this.write('info', label, [message, ...args]),
      warn: (message, ...args) => this.write('warn', label, [message, ...args]),
      error: (message, ...args) => this.write('error', label, [message, ...args])
    }
  }

  /** 调整保留数量并立即轮转；返回实际生效的值 */
  setMaxFiles(value: unknown): number {
    this.limit = normalizeLogMaxFiles(value, this.limit)
    this.sink.prune(this.limit)
    return this.limit
  }

  status(): LogStatus {
    return { maxFiles: this.limit, directory: this.sink.directory, file: this.sink.file }
  }

  /**
   * 供 cordis logger 导出器与 `ipc:log/write` 事件使用：级别与作用域已由
   * 消息/请求给出，这里只负责格式化并落盘。
   */
  record(level: LogLevel, scope: string, args: unknown[], ts: number): void {
    this.append(level, scope, formatArgs(args), ts)
  }

  /**
   * 补录日志服务就绪之前的消息。
   *
   * cordis 的 LoggerService 自带一个滚动缓冲区；日志插件通常不是第一个激活的，
   * 启动阶段的内核日志、插件加载日志因此要先从这里回放，才不会丢。
   */
  importHistory(entries: readonly LogHistoryEntry[]): number {
    for (const entry of entries) {
      this.append(entry.type, entry.name, formatArgs(entry.args), entry.ts)
    }
    return entries.length
  }

  private write(level: LogLevel, scope: string, args: unknown[]): void {
    this.append(level, scope, formatArgs(args), Date.now())
  }

  private append(level: LogLevel, scope: string, text: string, ts: number): void {
    const label = scopeLabel(scope)
    this.sink.write(formatLine(level, label, text, ts))
    try {
      this.mirror?.(level, label, text)
    } catch {
      // 控制台镜像只是开发便利，失败不能影响落盘
    }
  }
}

/** 作用域标签：去空白、压成单行、限长 */
function scopeLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const label = text || DEFAULT_SCOPE
  return label.slice(0, MAX_SCOPE_LENGTH).replace(/[\r\n]+/g, ' ')
}
