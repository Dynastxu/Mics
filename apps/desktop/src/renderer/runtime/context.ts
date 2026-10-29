import { Context } from 'cordis'
import type { LogWriteRequest } from '@mics/sdk'
import { installLogSink, logError, logInfo } from './logging'
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
  // 等 IPC 通道可用后再接日志出口：之后的启动信息与插件加载日志都会进主进程日志文件
  await ctx.inject(['ipc'], () => {})
  installLogSink((level, args) => {
    const request: LogWriteRequest = { level, args }
    void ctx.ipc.invoke('mics.logger', 'log/write', request).catch(() => {
      // 日志服务还没激活或主进程正在退出：渲染端不因此阻塞
    })
  })
  logInfo('渲染器启动 · 平台 %s', ctx.bridge.platform)

  ctx.plugin(CommandsService)
  ctx.plugin(ThemeService)
  ctx.plugin(UiService)
  ctx.plugin(PluginsService)

  // 等清单加载完成（PluginsService 的异步 init）
  await ctx.inject(['plugins'], () => {})
  store.ready = true
  logInfo('渲染器就绪：%d 个插件清单，%d 个导航项', store.plugins.length, store.nav.length)

  // 主进程序列化后的插件状态变化 -> 刷新本地快照
  ctx.inject(['plugins', 'ipc'], (ctx) => {
    ctx.ipc.on('plugins/changed', () => {
      void ctx.plugins.refresh?.()
    })
  })
}

// 入口异常也要留下记录；此时日志出口可能还没建立，logging 会退回控制台
export function reportBootError(error: unknown): void {
  logError('渲染器启动失败', error)
}
