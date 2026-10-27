import { Context } from 'cordis'
import { store } from './store'
import { BridgeService } from './services/bridge'
import { CommandsService } from './services/commands'
import { IpcService } from './services/ipc'
import { PluginsService } from './services/plugins'
import { ThemeService } from './services/theme'
import { UiService } from './services/ui'

let runtime: Context | null = null

export function getContext(): Context {
  if (!runtime) throw new Error('[mics] 渲染器运行时尚未创建')
  return runtime
}

/**
 * 渲染进程也是一个 cordis 应用：
 * bridge / ipc / commands / ui / theme / plugins 各是一个服务插件。
 */
export async function boot(): Promise<void> {
  const ctx = new Context()
  runtime = ctx

  ctx.plugin(BridgeService)
  ctx.plugin(IpcService)
  ctx.plugin(CommandsService)
  ctx.plugin(ThemeService)
  ctx.plugin(UiService)
  ctx.plugin(PluginsService)

  // 等清单加载完成（PluginsService 的异步 init）
  await ctx.inject(['plugins'], () => {})
  store.ready = true

  // 主进程序列化后的插件状态变化 -> 刷新本地快照
  ctx.inject(['plugins', 'ipc'], (ctx) => {
    ctx.ipc.on('plugins/changed', () => {
      void ctx.plugins.refresh?.()
    })
  })
}
