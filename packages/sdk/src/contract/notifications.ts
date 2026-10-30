/**
 * 渲染进程通知服务（`ctx.notifications`）。
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

export interface NotificationsServiceApi {
  /** 当前展示中的通知；按加入顺序排列 */
  readonly items: readonly NotificationItem[]
  /** 推送一条通知，返回可用于主动关闭的 id */
  show(options: NotificationOptions | string): string
  dismiss(id: string): void
  clear(): void
}
