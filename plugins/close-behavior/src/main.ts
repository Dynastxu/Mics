import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { CloseBehavior } from './closeBehavior'
import { ClosePromptBroker } from './promptBroker'
import {
  CLOSE_ACTION_KEY,
  CLOSE_BEHAVIOR_CHANGED,
  DEFAULT_CLOSE_ACTION,
  DEFAULT_LOW_MEMORY_TRAY,
  LOW_MEMORY_TRAY_KEY,
  isCloseAction,
  normalizeCloseAction,
  normalizeLowMemoryTray,
  type CloseAction,
  type ClosePromptResponse,
  type CloseSettings
} from './shared'

export const name = 'mics.close-behavior'
export const inject = ['ipc', 'storage', 'mainWindow']

function readSettings(ctx: Context): CloseSettings {
  return {
    closeAction: normalizeCloseAction(
      ctx.storage.get<unknown>(CLOSE_ACTION_KEY, DEFAULT_CLOSE_ACTION)
    ),
    lowMemoryTray: normalizeLowMemoryTray(
      ctx.storage.get<unknown>(LOW_MEMORY_TRAY_KEY, DEFAULT_LOW_MEMORY_TRAY)
    )
  }
}

function writeCloseAction(ctx: Context, value: unknown): CloseAction {
  if (!isCloseAction(value)) throw new Error('未知的关闭行为')
  ctx.storage.set(CLOSE_ACTION_KEY, value)
  return value
}

function writeLowMemoryTray(ctx: Context, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('低内存托盘模式需要布尔值')
  ctx.storage.set(LOW_MEMORY_TRAY_KEY, value)
  return value
}

function publish(ctx: Context, settings: CloseSettings): CloseSettings {
  ctx.ipc.broadcast(CLOSE_BEHAVIOR_CHANGED, settings)
  return settings
}

/**
 * 关闭行为插件（主进程）。
 *
 * 托盘与窗口关闭属于 Electron 能力，只能在主进程实现；窗口本身由 bootstrap
 * 通过 `ctx.mainWindow` 暴露（插件不复制 BrowserWindow 配置）。确认框是渲染端的
 * `@mics/ui` ConfirmDialog，两边用 request / ack / respond 配合，`ClosePromptBroker`
 * 负责等待与超时。
 *
 * 低内存托盘模式（设置项 `lowMemoryTray`）在最小化时销毁主窗口以释放渲染进程，
 * 恢复时由宿主重建；下载、启动等主进程任务不受影响。
 *
 * 行为在 `onStartup` 激活：必须早于主窗口创建，才能捕获首次关闭。
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger(name)

  const broker = new ClosePromptBroker({
    broadcast: (topic, payload) => ctx.ipc.broadcast(topic, payload),
    logger
  })

  if (ctx.mainWindow.supported) {
    const behavior = new CloseBehavior({
      resolveAction: () => readSettings(ctx).closeAction,
      prompt: () => broker.request(),
      rememberAction: (action) => {
        writeCloseAction(ctx, action)
        publish(ctx, readSettings(ctx))
      },
      lowMemoryTray: () => readSettings(ctx).lowMemoryTray,
      window: ctx.mainWindow,
      logger
    })
    behavior.start()
    ctx.effect(() => () => {
      behavior.dispose()
      broker.dispose()
    })
  } else {
    logger.warn('宿主未提供主窗口生命周期，关闭行为仅保留设置页')
    ctx.effect(() => () => broker.dispose())
  }

  ctx.ipc.handle('settings/get', (): CloseSettings => readSettings(ctx))

  ctx.ipc.handle<Partial<CloseSettings> | undefined>('settings/set', (params): CloseSettings => {
    // 先校验全部字段再写，避免一个字段失败时另一个已经落盘
    if (params?.closeAction !== undefined && !isCloseAction(params.closeAction)) {
      throw new Error('未知的关闭行为')
    }
    if (params?.lowMemoryTray !== undefined && typeof params.lowMemoryTray !== 'boolean') {
      throw new Error('低内存托盘模式需要布尔值')
    }

    if (params?.closeAction !== undefined) writeCloseAction(ctx, params.closeAction)
    if (params?.lowMemoryTray !== undefined) writeLowMemoryTray(ctx, params.lowMemoryTray)
    const settings = publish(ctx, readSettings(ctx))
    logger.info('关闭设置已更新：%s · 低内存托盘=%s', settings.closeAction, settings.lowMemoryTray)
    return settings
  })

  ctx.ipc.handle<{ id?: unknown } | undefined>('prompt/ack', (params) => broker.ack(params?.id))

  ctx.ipc.handle<Partial<ClosePromptResponse> | undefined>('prompt/respond', (params) =>
    broker.respond(params)
  )
}

export default defineMainPlugin({ name, inject, apply })
