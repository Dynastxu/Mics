import { createApp } from 'vue'
import type { Context } from 'cordis'
import { writeLog } from '@mics/sdk'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import { clearNotifications, showNotification } from './state'
import NotificationHost from './NotificationHost.vue'

export const name = 'mics.notifications'
export const inject = ['ipc']

export function apply(ctx: Context): void {
  // 通知是事件，不是服务：其它插件 emit 后有没有订阅者都不影响它们自己的生命周期。
  // 事件在渲染进程内派发，通知插件被禁用时自然没有监听者。
  const offShow = ctx.on('notification/show', (options) => {
    showNotification(options)
    writeLog(
      ctx,
      'debug',
      '[notifications] 通知入队：%s',
      typeof options === 'string' ? options : options.message
    )
  })

  // 通知宿主直接挂到 body，不依赖 shell 的页面/覆盖层插槽。
  // Vue 运行时由 shell 注入，这里创建的是独立应用，卸载时连同 DOM 一起清理。
  const root = document.createElement('div')
  root.className = 'notification-root'
  document.body.appendChild(root)
  const app = createApp(NotificationHost)
  app.mount(root)

  ctx.effect(() => () => {
    offShow()
    app.unmount()
    root.remove()
    clearNotifications()
  })
}

export default defineRendererPlugin({ name, inject, apply })
