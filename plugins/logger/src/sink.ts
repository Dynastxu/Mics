import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const FILE_PREFIX = 'mics-'
const FILE_SUFFIX = '.log'

interface StoredFile {
  name: string
  modifiedAt: number
}

/**
 * 单次启动的日志文件。
 *
 * 只负责「一个文件 + 目录轮转」：同步追加，进程退出时不会丢尾部；
 * 日志量小，不引入写队列。任何磁盘错误只报告一次，绝不拖垮宿主。
 */
export class LogSink {
  readonly directory: string
  private current = ''
  private reported = false

  constructor(directory: string, now: Date = new Date()) {
    this.directory = directory
    try {
      mkdirSync(directory, { recursive: true })
      this.current = this.create(now)
    } catch (error) {
      this.report(error)
    }
  }

  get file(): string {
    return this.current
  }

  /** 追加一行（行尾换行由调用方负责） */
  write(line: string): void {
    if (!this.current) return
    try {
      appendFileSync(this.current, line, 'utf8')
    } catch (error) {
      this.report(error)
    }
  }

  /** 只保留最近的 maxFiles 个日志文件；当前文件始终保留 */
  prune(maxFiles: number): void {
    if (!this.current) return
    try {
      const files = this.list()
      const keep = new Set<string>([path.basename(this.current)])
      for (const file of files) {
        if (keep.size >= maxFiles) break
        keep.add(file.name)
      }
      for (const file of files) {
        if (keep.has(file.name)) continue
        rmSync(path.join(this.directory, file.name), { force: true })
      }
    } catch (error) {
      this.report(error)
    }
  }

  private list(): StoredFile[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(FILE_PREFIX) && entry.name.endsWith(FILE_SUFFIX),
      )
      .map((entry) => ({
        name: entry.name,
        modifiedAt: statSync(path.join(this.directory, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  private create(now: Date): string {
    const stamp = timestampForName(now)
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? '' : `-${index}`
      const file = path.join(this.directory, `${FILE_PREFIX}${stamp}${suffix}${FILE_SUFFIX}`)
      try {
        // wx：只创建不覆盖，避免两个实例同时启动时写到同一个文件
        writeFileSync(file, '', { encoding: 'utf8', flag: 'wx' })
        return file
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error(`无法在 ${this.directory} 下创建日志文件`)
  }

  private report(error: unknown): void {
    if (this.reported) return
    this.reported = true
    const message = error instanceof Error ? error.message : String(error)
    // 不能走 ctx.logger：日志插件自身的失败会形成递归
    console.error(`[mics.logger] 写入日志失败：${message}`)
  }
}

/** 文件名里的本地时间戳，例如 20260509-203000-123 */
function timestampForName(now: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    pad(now.getMilliseconds(), 3),
  ].join('-')
}
