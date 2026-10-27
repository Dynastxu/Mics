import { shell } from 'electron'
import type { Context } from 'cordis'
import type { KernelConfig, PluginId, RuntimeSnapshot } from '@mics/sdk'
import { CommandsService } from './services/commands'
import { IpcService } from './services/ipc'
import { PermissionsService } from './services/permissions'
import { PluginsService } from './services/plugins'
import { StorageService } from './services/storage'


export const name = 'mics.kernel'

/**
 * 内核插件。
 *
 * 它和普通插件一样由 bootstrap 通过 `ctx.plugin()` 挂载；
 * 区别只在于它负责把「插件」这件事本身做成服务：
 *   plugins / ipc / commands / storage / permissions
 * 其余插件则挂在它下面，由 cordis 负责依赖注入与生命周期。
 */
export function apply(ctx: Context, config: KernelConfig): void {
  ctx.plugin(StorageService, config)
  ctx.plugin(PermissionsService, config)
  ctx.plugin(PluginsService, config)
  ctx.plugin(CommandsService)
  ctx.plugin(IpcService)

  // 等内核服务就绪后，再对外暴露系统 RPC 并启动开机插件
  ctx.inject(['ipc', 'plugins', 'commands', 'permissions'], (ctx) => {
    const snapshot = (): RuntimeSnapshot => ({
      app: config.app,
      plugins: ctx.plugins.list(),
      commands: ctx.commands.list(),
    })

    ctx.ipc.handle('runtime/snapshot', snapshot)
    ctx.ipc.handle('plugins/list', () => ctx.plugins.list())
    ctx.ipc.handle<{ id: PluginId }>('plugins/activate', async ({ id }) => {
      await ctx.plugins.activate(id)
    })
    ctx.ipc.handle<{ id: PluginId }>('plugins/disable', async ({ id }) => {
      await ctx.plugins.disable(id)
    })
    ctx.ipc.handle<{ id: PluginId }>('plugins/enable', async ({ id }) => {
      await ctx.plugins.enable(id)
    })
    ctx.ipc.handle('commands/list', () => ctx.commands.list())
    ctx.ipc.handle<{ id: string; args?: unknown[] }>('commands/execute', async ({ id, args }) => {
      return ctx.commands.execute(id, ...(args ?? []))
    })
    ctx.ipc.handle<{ url: string }>('host/openExternal', async ({ url }, meta) => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('只允许打开 http(s) 链接')
      }
      if (!ctx.permissions.allows(meta.callerId, 'shell:openExternal')) {
        throw new Error(`插件 ${meta.callerId ?? 'unknown'} 缺少 shell:openExternal 权限`)
      }
      await shell.openExternal(url)
    })

    // 插件状态变化 -> 广播给渲染进程
    ctx.on('plugins/changed', () => {
      ctx.ipc.emit('plugins/changed', snapshot())
    })

    // 不阻塞 bootstrap：窗口可以先显示，插件在后台激活
    void ctx.plugins.activateStartup?.()
  })
}

export default { name, apply }
