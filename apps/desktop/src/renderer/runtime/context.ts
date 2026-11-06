import { Context } from 'cordis'
import { emitRuntime } from '@mics/sdk'
import { installLogSink, logError, logInfo, logWarn } from './logging'
import { failBootScreen, hideBootScreen } from '../boot-screen'
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
    // 写日志走事件而不是 RPC：logger 插件未启用时没有订阅者，事件直接丢弃，
    // 渲染端不会因此等待或报错。
    ctx.ipc.emit('ipc:log/write', { level, args, scope: 'renderer' })
  })
  logInfo('渲染器启动 · 平台 %s', ctx.bridge.platform)

  /**
   * 跨进程事件边界。
   *
   * 主进程广播的 `mics:event` 帧在这里落地成同名本地 Cordis 事件，
   * 于是插件在两边都只写 `ctx.on('ipc:...')`，不必知道事件从哪个进程来。
   * 只做 `emit` 语义：waterfall / bail 依赖 `next()` 与返回值，不能跨进程，
   * 需要请求-响应请走 RPC。
   *
   * 订阅本身跟随渲染进程生命周期（与窗口同生共死），不需要 effect 回收。
   */
  ctx.bridge.on('*', (envelope) => {
    emitRuntime(ctx, envelope.topic, envelope.payload)
  })

  ctx.plugin(CommandsService)
  ctx.plugin(ThemeService)
  ctx.plugin(UiService)
  ctx.plugin(PluginsService)

  // 等清单加载完成（PluginsService 的异步 init）
  // 所有步骤都放在 inject 回调里执行：回调由 cordis 在服务可用时调用，
  // 在外面 `await` 拿到的只是 fiber，不保证回调已经跑过（plugins 可能仍是 undefined）。
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    // 兜底：服务始终没就绪也不能让窗口永远白屏
    setTimeout(() => {
      if (settled) return
      logWarn('等待 plugins 服务超时，先放行界面')
      finish()
    }, 10000)
    ctx.inject(['plugins'], (scoped) => {
      void (async () => {
        try {
          // 服务在 init 完成前就可注入，必须等快照真正落地
          await scoped.plugins.whenReady?.()
          await scoped.plugins.activateAll?.()
        } catch (error) {
          logError('渲染端插件加载失败', error)
        } finally {
          finish()
        }
      })()
    })
  })

  store.ready = true
  logInfo('渲染器就绪：%d 个插件清单，%d 个导航项', store.plugins.length, store.nav.length)
  // 插件已加载完，启动页退场，交给 shell 绘制
  hideBootScreen()

  // 主进程序列化后的插件状态变化 -> 刷新本地快照
  ctx.inject(['plugins'], (ctx) => {
    ctx.on('ipc:plugins/changed', () => {
      void ctx.plugins.refresh?.()
    })
  })
}

// 入口异常也要留下记录；此时日志出口可能还没建立，logging 会退回控制台
export function reportBootError(error: unknown): void {
  logError('渲染器启动失败', error)
  failBootScreen('启动失败', [error instanceof Error ? error.message : String(error)])
}
