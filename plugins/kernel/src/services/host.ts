import os from 'node:os'
import { shell } from 'electron'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  HostShellApi,
  KernelConfig,
  PermissionsServiceApi,
  PluginHostApp,
  PluginHostPaths,
  PluginId
} from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'

/**
 * 宿主能力（进程内实现）。
 *
 * 子进程里由 `@mics/plugin-host` 用启动参数构造同一份形状，所以插件写
 * `ctx.host.paths.userData` 在两种执行位置都能跑——这是把插件从 `electron`
 * 上摘下来的第一步。
 *
 * `paths.pluginDir` 按**调用方**插件解析：cordis 的 tracker 会把 `this.ctx`
 * 换成调用点的上下文，`pluginIdOf` 因此拿到的是真正的插件 id。
 */
export class HostService extends Service {
  static inject: string[] = []

  private readonly config: KernelConfig
  private readonly pluginDirs = new Map<PluginId, string>()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'host')
    this.config = config
    for (const record of config.plugins) {
      this.pluginDirs.set(record.manifest.id, record.dir)
    }
  }

  get paths(): PluginHostPaths {
    const id = pluginIdOf(this.ctx)
    return {
      userData: this.config.userDataDir,
      pluginDir: (id ? this.pluginDirs.get(id) : undefined) ?? this.config.userDataDir,
      temp: os.tmpdir(),
      home: os.homedir()
    }
  }

  get app(): PluginHostApp {
    return { version: this.config.app.version, isDev: this.config.app.isDev }
  }

  /**
   * 系统交互的代做入口。
   *
   * `openExternal` 要求调用方声明 `shell:openExternal`（v1 字符串或
   * `os.openExternal`），与内核 `host/openExternal` RPC 用的是同一条检查。
   */
  get shell(): HostShellApi {
    return {
      openExternal: async (url: string): Promise<void> => {
        await this.openExternalFor(pluginIdOf(this.ctx), url)
      },
      openPath: async (target: string): Promise<string> => {
        return await shell.openPath(target)
      }
    }
  }

  /** 内核代子进程插件调用：显式传插件 id，不走调用方追踪 */
  async openExternalFor(pluginId: PluginId | undefined, url: string): Promise<void> {
    const permissions = this.ctx.get('permissions') as PermissionsServiceApi | undefined
    if (pluginId && permissions && !permissions.allows(pluginId, 'shell:openExternal')) {
      throw new Error(`插件 ${pluginId} 缺少 shell:openExternal 权限`)
    }
    await shell.openExternal(url)
  }

  async openPathFor(target: string): Promise<string> {
    return await shell.openPath(target)
  }
}
