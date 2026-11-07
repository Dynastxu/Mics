import os from 'node:os'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { KernelConfig, PluginHostApp, PluginHostPaths, PluginId } from '@mics/sdk'
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
}
