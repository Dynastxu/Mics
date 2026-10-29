import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  ConfigurationContribution,
  ConfigurationProperty,
  ConfigurationSource,
  ConfigurationValue,
  KernelConfig,
  PluginId,
} from '@mics/sdk'
import { normalizeConfigurationValue, pluginIdOf } from '@mics/sdk'

type Dictionary = Record<string, unknown>

export interface ResolvedConfiguration {
  value?: ConfigurationValue
  source: ConfigurationSource | 'unset'
}

export type ConfigurationSchemaResolver = (
  pluginId: PluginId,
) => ConfigurationContribution | undefined

/**
 * 按插件隔离的 JSON 存储。
 *
 * 通过 cordis 的调用方追踪，`ctx.storage.get('key')` 自动落到所属插件自己的文件上。
 *
 * 清单声明 `contributes.configuration` 后，这里同时承担「类型化存储」：
 *   - `get` 按 schema 校验存储值，并按「用户值 → profile 默认 → schema 默认」取值；
 *   - `set` 校验后再落盘，避免把错误类型写进文件；
 *   - `getFor/setFor` 让内核的配置服务按插件 id 读写（设置页与 agent 用）。
 */
export class StorageService extends Service {
  static inject: string[] = []

  private readonly config: KernelConfig
  private readonly cache = new Map<PluginId, Dictionary>()
  private readonly warned = new Set<string>()
  /** 由 ConfigurationService 注入：从插件清单里取当前 schema */
  private resolver?: ConfigurationSchemaResolver

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'storage')
    this.config = config
  }

  /** 内核初始化时由 ConfigurationService 挂上；之后热重载清单也能立刻生效 */
  setSchemaResolver(resolver: ConfigurationSchemaResolver): void {
    this.resolver = resolver
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const resolved = this.resolveFor(this.pluginId(), key)
    return resolved.value !== undefined ? (resolved.value as T) : fallback
  }

  set(key: string, value: unknown): void {
    const id = this.pluginId()
    const normalized = this.normalizeFor(id, key, value)
    const data = this.dataFor(id)
    data[key] = normalized
    this.warned.delete(`${id}:${key}`)
    this.flushFor(id, data)
  }

  delete(key: string): void {
    const id = this.pluginId()
    const data = this.dataFor(id)
    delete data[key]
    this.warned.delete(`${id}:${key}`)
    this.flushFor(id, data)
  }

  keys(): string[] {
    return Object.keys(this.dataFor(this.pluginId()))
  }

  /**
   * 当前生效值及来源。
   *
   * 优先级：用户保存 > profile 默认 > schema 默认。用户值不符合 schema 时
   * 记一条警告并继续往下取，避免一个坏值把设置页卡死。
   */
  resolveFor(id: PluginId, key: string): ResolvedConfiguration {
    const schema = this.schemaFor(id, key)
    const data = this.dataFor(id)

    if (key in data) {
      if (!schema) return { value: data[key] as ConfigurationValue, source: 'user' }
      const normalized = normalizeConfigurationValue(schema, data[key])
      if (normalized.ok) return { value: normalized.value, source: 'user' }
      this.warnOnce(id, key, `存储值不符合 schema：${normalized.error}`)
    }

    // profile 只覆盖清单声明过 schema 的原始类型设置；
    // 没有 schema 的键（例如下载源的数组）继续由插件自己的设置页管理。
    const profileValue = schema ? this.config.profile?.settings?.[id]?.[key] : undefined
    if (profileValue !== undefined) {
      const normalized = normalizeConfigurationValue(schema as ConfigurationProperty, profileValue)
      if (normalized.ok) return { value: normalized.value, source: 'profile' }
      this.warnOnce(id, key, `profile 值不符合 schema：${normalized.error}`)
    }

    if (schema?.default !== undefined) {
      return { value: schema.default, source: 'default' }
    }
    return { source: 'unset' }
  }

  /** 按插件 id 读取原始用户值（不套 profile / 默认值） */
  getFor(id: PluginId, key: string): unknown {
    return this.dataFor(id)[key]
  }

  /** 按插件 id 写入；同样经过 schema 校验 */
  setFor(id: PluginId, key: string, value: unknown): void {
    const normalized = this.normalizeFor(id, key, value)
    const data = this.dataFor(id)
    data[key] = normalized
    this.warned.delete(`${id}:${key}`)
    this.flushFor(id, data)
  }

  deleteFor(id: PluginId, key: string): void {
    const data = this.dataFor(id)
    delete data[key]
    this.warned.delete(`${id}:${key}`)
    this.flushFor(id, data)
  }

  keysFor(id: PluginId): string[] {
    return Object.keys(this.dataFor(id))
  }

  /** 插件被卸载后丢掉内存缓存，避免重装时读到已删除的数据 */
  forget(id: PluginId): void {
    this.cache.delete(id)
    for (const key of this.warned) {
      if (key.startsWith(`${id}:`)) this.warned.delete(key)
    }
  }

  private pluginId(): PluginId {
    return pluginIdOf(this.ctx) ?? this.config.kernel
  }

  private schemaFor(id: PluginId, key: string): ConfigurationProperty | undefined {
    return this.resolver?.(id)?.properties[key]
  }

  private normalizeFor(id: PluginId, key: string, value: unknown): unknown {
    const schema = this.schemaFor(id, key)
    if (!schema) return value
    const normalized = normalizeConfigurationValue(schema, value)
    if (!normalized.ok) {
      throw new Error(`设置 ${key} 无效：${normalized.error}`)
    }
    return normalized.value
  }

  private warnOnce(id: PluginId, key: string, message: string): void {
    const mark = `${id}:${key}`
    if (this.warned.has(mark)) return
    this.warned.add(mark)
    this.ctx.logger('storage').warn(`插件 ${id} 的配置 ${key}：${message}`)
  }

  private dataFor(id: PluginId): Dictionary {
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

  private flushFor(id: PluginId, data: Dictionary): void {
    try {
      mkdirSync(path.dirname(this.file(id)), { recursive: true })
      writeFileSync(this.file(id), JSON.stringify(data, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger('storage').warn(`写入插件存储失败：${(error as Error).message}`)
    }
  }
}
