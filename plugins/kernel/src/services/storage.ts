import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { KernelConfig, PluginId } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'

type Dictionary = Record<string, unknown>

/**
 * 按插件隔离的 JSON 存储。
 * 通过 cordis 的调用方追踪，`ctx.storage.get('key')` 自动落到所属插件自己的文件上。
 */
export class StorageService extends Service {
  static inject: string[] = []

  private readonly config: KernelConfig
  private readonly cache = new Map<PluginId, Dictionary>()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'storage')
    this.config = config
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const data = this.data()
    return key in data ? (data[key] as T) : fallback
  }

  set(key: string, value: unknown): void {
    const data = this.data()
    data[key] = value
    this.flush(data)
  }

  delete(key: string): void {
    const data = this.data()
    delete data[key]
    this.flush(data)
  }

  keys(): string[] {
    return Object.keys(this.data())
  }

  private pluginId(): PluginId {
    return pluginIdOf(this.ctx) ?? this.config.kernel
  }

  private data(): Dictionary {
    const id = this.pluginId()
    let data = this.cache.get(id)
    if (!data) {
      data = this.read(id)
      this.cache.set(id, data)
    }
    return data
  }

  private file(id: PluginId): string {
    return path.join(this.config.userDataDir, 'plugin-storage', `${id}.json`)
  }

  private read(id: PluginId): Dictionary {
    try {
      const parsed = JSON.parse(readFileSync(this.file(id), 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Dictionary) : {}
    } catch {
      return {}
    }
  }

  private flush(data: Dictionary): void {
    const id = this.pluginId()
    try {
      mkdirSync(path.dirname(this.file(id)), { recursive: true })
      writeFileSync(this.file(id), JSON.stringify(data, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger('storage').warn(`写入插件存储失败：${(error as Error).message}`)
    }
  }
}
