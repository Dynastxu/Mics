import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { KernelConfig, Permission, PluginId } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'

/**
 * 能力门控。清单里的 permissions 是声明，
 * 这里负责校验某个插件是否被授予了某项能力（宿主服务调用前检查）。
 */
export class PermissionsService extends Service {
  static inject: string[] = []

  private readonly grants = new Map<PluginId, Set<string>>()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'permissions')
    for (const record of config.plugins) {
      this.grants.set(record.manifest.id, new Set(record.manifest.permissions ?? []))
    }
  }

  has(permission: Permission | string): boolean {
    const id = pluginIdOf(this.ctx)
    if (!id) return true
    return this.allows(id, permission)
  }

  require(permission: Permission | string): void {
    if (!this.has(permission)) {
      throw new Error(`插件 ${pluginIdOf(this.ctx) ?? 'unknown'} 缺少权限 ${permission}`)
    }
  }

  allows(pluginId: PluginId | undefined, permission: Permission | string): boolean {
    if (!pluginId) return true
    return this.grants.get(pluginId)?.has(permission) ?? false
  }
}
