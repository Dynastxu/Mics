import { Service } from 'cordis'
import type { Context } from 'cordis'
import type {
  NotificationItem,
  NotificationOptions,
  NotificationsServiceApi,
} from '@mics/sdk'
import {
  clearNotifications,
  dismissNotification,
  notificationItems,
  showNotification,
} from './state'

/** 渲染进程通知服务（`ctx.notifications`）。 */
export class NotificationsService extends Service implements NotificationsServiceApi {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'notifications')
  }

  get items(): readonly NotificationItem[] {
    return notificationItems
  }

  show(options: NotificationOptions | string): string {
    const id = showNotification(options)
    void this.ctx.ipc.invoke('mics.logger', 'log/write', {
      level: 'debug',
      args: ['[notifications] 通知入队：%s', typeof options === 'string' ? options : options.message],
    }).catch(() => undefined)
    return id
  }

  dismiss(id: string): void {
    dismissNotification(id)
  }

  clear(): void {
    clearNotifications()
  }
}
