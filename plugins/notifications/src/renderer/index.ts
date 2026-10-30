import { createApp } from 'vue'
import type { Context } from 'cordis'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import type { NotificationsServiceApi } from '@mics/sdk'
import { clearNotifications } from './state'
import { NotificationsService } from './service'
import NotificationHost from './NotificationHost.vue'

export const name = 'mics.notifications'
export const inject = ['ipc']

export function apply(ctx: Context): void {
  // 服务先于宿主注册：页面代码在通知宿主挂载之前就可以推送
  const service = new NotificationsService(ctx)

  // 跨插件的全局出口：渲染端插件作用域之间的服务可见性跟随 fiber，
  // 这里同时提供一个直接挂在 window 上的通知 API，页面即使拿不到服务也能提示。
  const api: NotificationsServiceApi = {
    get items() {
      return service.items
    },
    show: (options) => service.show(options),
    dismiss: (id) => service.dismiss(id),
    clear: () => service.clear(),
  }
  ;(globalThis as typeof globalThis & { __MICS_NOTIFICATIONS__?: NotificationsServiceApi })
    .__MICS_NOTIFICATIONS__ = api
  ctx.effect(() => () => {
    const host = globalThis as typeof globalThis & { __MICS_NOTIFICATIONS__?: NotificationsServiceApi }
    if (host.__MICS_NOTIFICATIONS__ === api) delete host.__MICS_NOTIFICATIONS__
  })

  // 通知宿主直接挂到 body，不依赖 shell 的页面/覆盖层插槽。
  // Vue 运行时由 shell 注入，这里创建的是独立应用，卸载时连同 DOM 一起清理。
  const root = document.createElement('div')
  root.className = 'notification-root'
  document.body.appendChild(root)
  const app = createApp(NotificationHost)
  app.mount(root)
  void ctx.ipc.invoke('mics.logger', 'log/write', {
    level: 'debug',
    args: ['[notifications] 通知宿主已挂载'],
  }).catch(() => undefined)

  ctx.effect(() => () => {
    app.unmount()
    root.remove()
    clearNotifications()
  })
}

export default defineRendererPlugin({ name, inject, apply })
