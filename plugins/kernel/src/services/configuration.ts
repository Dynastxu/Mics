import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  ConfigurationContribution,
  ConfigurationProperty,
  PluginConfigurationInfo,
  PluginId,
} from '@mics/sdk'
import { normalizeConfigurationValue } from '@mics/sdk'
import { StorageService } from './storage'

/**
 * 配置服务：把清单里的 `contributes.configuration` 变成可读写的结构化配置。
 *
 * 职责分离：
 *   - schema 从 `PluginsService` 的清单里实时取，热重载后立刻生效；
 *   - 值的读写交给 `StorageService`，因此插件自己的 `ctx.storage` 调用、
 *     设置页和 agent 看到的是同一套默认值与校验规则。
 *
 * `StorageService` 通过 `setSchemaResolver()` 反向使用这里的 schema，
 * 插件代码不需要改成 `ctx.configuration.*` 也能获得校验与默认值。
 */
export class ConfigurationService extends Service {
  static inject = ['plugins', 'storage']

  private readonly owner: Context

  constructor(ctx: Context) {
    super(ctx, 'configuration')
    this.owner = ctx
  }

  [Service.init](): void {
    const storage = this.owner.storage as StorageService
    storage.setSchemaResolver((id) => this.schemaOf(id))
  }

  list(): PluginConfigurationInfo[] {
    const result: PluginConfigurationInfo[] = []
    for (const plugin of this.owner.plugins.list()) {
      const info = this.describe(plugin.id)
      if (info) result.push(info)
    }
    return result
  }

  describe(id: PluginId): PluginConfigurationInfo | undefined {
    const plugin = this.owner.plugins.get(id)
    if (!plugin) return undefined
    const schema = this.schemaOf(id)
    if (!schema) return undefined
    const storage = this.owner.storage as StorageService

    return {
      pluginId: id,
      name: plugin.name,
      title: schema.title ?? plugin.name,
      description: schema.description,
      // 有自带设置页的插件也照常返回：agent 需要读全部配置，界面只是换成页面入口
      settingsView: schema.settingsView,
      properties: Object.entries(schema.properties).map(([key, property]) => {
        const resolved = storage.resolveFor(id, key)
        return {
          ...property,
          key,
          value: resolved.value,
          source: resolved.source,
        }
      }),
    }
  }

  set(id: PluginId, key: string, value: unknown): PluginConfigurationInfo {
    const property = this.requireProperty(id, key)
    const normalized = normalizeConfigurationValue(property, value)
    if (!normalized.ok) throw new Error(`设置 ${key} 无效：${normalized.error}`)
    const storage = this.owner.storage as StorageService
    storage.setFor(id, key, normalized.value)
    return this.describe(id) as PluginConfigurationInfo
  }

  reset(id: PluginId, key: string): PluginConfigurationInfo {
    this.requireProperty(id, key)
    const storage = this.owner.storage as StorageService
    storage.deleteFor(id, key)
    return this.describe(id) as PluginConfigurationInfo
  }

  private schemaOf(id: PluginId): ConfigurationContribution | undefined {
    return this.owner.plugins.get(id)?.manifest.contributes?.configuration
  }

  private requireProperty(id: PluginId, key: string): ConfigurationProperty {
    const property = this.schemaOf(id)?.properties[key]
    if (!property) {
      throw new Error(`插件 ${id} 没有声明配置 ${key}`)
    }
    return property
  }
}
