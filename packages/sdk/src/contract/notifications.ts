import type { Context } from 'cordis'
import { emitEvent } from './events'

/**
 * 通知的共享契约。
 *
 * 通知不是服务：插件用 `emitNotification()` 发出 `notification/show` 事件，
 * `mics.notifications` 只是这个事件的可选订阅者。禁用通知插件不会让任何插件
 * 停在等待服务的状态。
 *
 * 通知只在界面内显示，不做系统托盘/系统通知；需要系统通知的场景应由主进程
 * 另行申请 `notifications:show` 权限。这里的通道面向「操作已受理、请去某页
 * 查看进度」这类短暂反馈。
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface NotificationOptions {
  /** 可选标题；没有标题时只显示正文 */
  title?: string
  message: string
  level?: NotificationLevel
  /** 自动关闭时间（毫秒）；0 表示不自动关闭 */
  duration?: number
}

export interface NotificationItem {
  id: string
  title: string
  message: string
  level: NotificationLevel
  createdAt: number
}

/** 通过事件发起通知，不需要 inject 通知插件。 */
export function emitNotification(ctx: Context, options: NotificationOptions | string): void {
  emitEvent(ctx, 'notification/show', options)
}
