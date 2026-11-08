import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { KernelConfig, PluginId, PluginPermissions, TrustLevel } from '@mics/sdk'
import { allowsLegacy, pluginIdOf } from '@mics/sdk'

/**
 * 能力门控。
 *
 * 扫描阶段已经把清单里的 `permissions` 归一化成 `PluginPermissions`
 * （v1 数组会变成 `trust: "full"` + `os.*`），这里只负责「某插件有没有某项能力」。
 *
 * 判定分两类：
 *   - 引擎级（fs 与子进程）：由插件子进程的 `--permission` 强制，本服务不参与；
 *   - 宿主代做（剪贴板、通知、打开外链、对话框）：宿主在调用点校验。
 *
 * `has()` / `allows()` 保留 v1 字符串入参，既有调用点不需要改。
 */
export class PermissionsService extends Service {
  static inject: string[] = []

  private readonly grants = new Map<PluginId, PluginPermissions>()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'permissions')
    for (const record of config.plugins) {
      this.grants.set(record.manifest.id, record.manifest.permissions ?? { trust: 'full' })
    }
  }

  has(permission: string): boolean {
    const id = pluginIdOf(this.ctx)
    if (!id) return true
    return this.allows(id, permission)
  }

  require(permission: string): void {
    if (!this.has(permission)) {
      throw new Error(`插件 ${pluginIdOf(this.ctx) ?? 'unknown'} 缺少权限 ${permission}`)
    }
  }

  allows(pluginId: PluginId | undefined, permission: string): boolean {
    if (!pluginId) return true
    const declared = this.grants.get(pluginId)
    if (!declared) return false
    return allowsLegacy(declared, permission)
  }

  /** 某个插件的完整声明；未知插件返回 undefined */
  of(pluginId: PluginId): PluginPermissions | undefined {
    return this.grants.get(pluginId)
  }

  /** 信任级别；未知插件按 full 处理（与今天的模型一致） */
  trustOf(pluginId: PluginId): TrustLevel {
    return this.grants.get(pluginId)?.trust ?? 'full'
  }
}
