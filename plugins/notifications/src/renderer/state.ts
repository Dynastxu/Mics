import { reactive } from 'vue'
import type {
  NotificationItem,
  NotificationLevel,
  NotificationOptions,
} from '@mics/sdk'

/**
 * 通知队列是模块级状态：服务负责入队/定时，宿主组件负责绘制。
 *
 * 两者分开后宿主不需要从 cordis 上下文取服务，插件被禁用时宿主随覆盖层一起
 * 卸载，队列与定时器由插件 fiber 清理。
 */

const MAX_VISIBLE = 5
const items = reactive<NotificationItem[]>([])
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let sequence = 0

function defaultDuration(level: NotificationLevel): number {
  if (level === 'error') return 8000
  if (level === 'warning') return 6500
  return 4500
}

function normalize(input: NotificationOptions | string): NotificationOptions {
  return typeof input === 'string' ? { message: input } : input
}

export function showNotification(input: NotificationOptions | string): string {
  const options = normalize(input)
  const level = options.level ?? 'info'
  const message = options.message?.trim() || options.title?.trim() || '操作已完成'
  const title = options.title?.trim() ?? ''
  sequence += 1
  const id = `notice_${sequence}`

  items.push({
    id,
    title,
    message,
    level,
    createdAt: Date.now(),
  })

  // 超过上限时先关掉最旧的一条，避免通知堆满窗口
  while (items.length > MAX_VISIBLE) {
    const oldest = items[0]
    if (!oldest) break
    dismissNotification(oldest.id)
  }

  const duration = options.duration ?? defaultDuration(level)
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismissNotification(id), duration))
  }
  return id
}

export function dismissNotification(id: string): void {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) items.splice(index, 1)
}

export function clearNotifications(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  items.splice(0, items.length)
}

export { items as notificationItems }
