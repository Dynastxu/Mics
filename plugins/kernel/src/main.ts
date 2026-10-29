import { shell } from 'electron'
import type { Context } from 'cordis'
import type { KernelConfig, PluginFailureStage, PluginId, RuntimeSnapshot } from '@mics/sdk'
import { CapabilitiesService } from './services/capabilities'
import { CommandsService } from './services/commands'
import { ConfigurationService } from './services/configuration'
import { IpcService } from './services/ipc'
import { PermissionsService } from './services/permissions'
import { PluginsService } from './services/plugins'
import { StorageService } from './services/storage'
import { auditEventModes } from './eventModeAudit'
import { installIpcAudit } from './cleanupAudit'


export const name = 'mics.kernel'

/**
 * 内核插件。
 *
 * 它和普通插件一样由 bootstrap 通过 `ctx.plugin()` 挂载；
 * 区别只在于它负责把「插件」这件事本身做成服务：
 *   plugins / ipc / commands / storage / permissions / capabilities
 * 其余插件则挂在它下面，由 cordis 负责依赖注入与生命周期。
 */
export function apply(ctx: Context, config: KernelConfig): void {
  const log = ctx.logger('mics.kernel')
  log.info(
    '内核启动：%s · %d 个插件 · profile %s · dev=%s',
    config.kernel,
    config.plugins.length,
    config.profile?.name ?? '无',
    config.app.isDev,
  )

  // 开发期审计：事件派发模式 + 插件直接注册的 ipcMain 资源
  if (config.app.isDev) {
    installIpcAudit()
    auditEventModes(ctx)
    log.debug('开发期审计已安装：ipcMain 注册 / 事件派发模式')
  }

  ctx.plugin(StorageService, config)
  ctx.plugin(PermissionsService, config)
  ctx.plugin(CapabilitiesService)
  ctx.plugin(PluginsService, config)
  ctx.plugin(ConfigurationService)
  ctx.plugin(CommandsService)
  ctx.plugin(IpcService)
  log.debug('内核服务已注册：storage / permissions / capabilities / plugins / configuration / commands / ipc')

  // 等内核服务就绪后，再对外暴露系统 RPC 并启动开机插件
  ctx.inject(['ipc', 'plugins', 'commands', 'permissions', 'configuration'], (ctx) => {
    log.info('内核服务就绪，开始注册系统 RPC 并激活启动插件')

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
    ctx.ipc.handle<{ id: PluginId }>('plugins/reload', async ({ id }) => {
      await ctx.plugins.reload?.(id)
    })
    ctx.ipc.handle<{ id: PluginId; message: string; stage?: PluginFailureStage }>(
      'plugins/fail',
      async ({ id, message, stage }) => {
        await ctx.plugins.fail?.(id, message, stage)
      },
    )
    // 只读诊断：依赖图、贡献点与未满足项，插件管理页与 agent 读同一份
    ctx.ipc.handle('plugins/diagnostics', () => ctx.plugins.diagnostics?.())
    // 配置：清单 schema + 当前值，设置页与 agent 共用
    ctx.ipc.handle('configuration/list', () => ctx.configuration.list())
    ctx.ipc.handle<{ pluginId: PluginId; key: string; value: unknown }>(
      'configuration/set',
      ({ pluginId, key, value }) => ctx.configuration.set(pluginId, key, value),
    )
    ctx.ipc.handle<{ pluginId: PluginId; key: string }>(
      'configuration/reset',
      ({ pluginId, key }) => ctx.configuration.reset(pluginId, key),
    )
    ctx.ipc.handle('commands/list', () => ctx.commands.list())
    ctx.ipc.handle<{ id: string; args?: unknown[] }>('commands/execute', async ({ id, args }) => {
      return ctx.commands.execute(id, ...(args ?? []))
    })
    ctx.ipc.handle<{ url: string }>('host/openExternal', async ({ url }) => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('只允许打开 http(s) 链接')
      }
      await shell.openExternal(url)
    })

    // 权限校验挂在派发前的拦截链上：内核只注册这一条，其它策略由插件自己挂。
    // 用 prepend 保证它先于业务插件执行，拦截结果不依赖注册顺序。
    ctx.on(
      'ipc/before',
      async (request, next) => {
        if (request.target === 'mics.kernel' && request.method === 'host/openExternal') {
          if (!ctx.permissions.allows(request.callerId, 'shell:openExternal')) {
            return {
              ok: false,
              error: {
                message: `插件 ${request.callerId ?? 'unknown'} 缺少 shell:openExternal 权限`,
              },
            }
          }
        }
        return next()
      },
      true,
    )

    // 插件状态变化 -> 广播给渲染进程
    ctx.on('plugins/changed', () => {
      ctx.ipc.emit('plugins/changed', snapshot())
    })

    // 不阻塞 bootstrap：窗口可以先显示，插件在后台激活
    void ctx.plugins.activateStartup?.().catch((error) => {
      log.error('启动插件激活未完成', error)
    })
  })
}

export default { name, apply }
