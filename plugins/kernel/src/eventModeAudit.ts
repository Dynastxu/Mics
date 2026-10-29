import type { Context } from 'cordis'
import { EVENT_MODES } from '@mics/sdk'

/**
 * 开发期的事件派发模式审计。
 *
 * `EVENT_MODES` 已经把「每个事件该用什么模式」写成了声明，但 cordis 的派发点
 * 仍然可能写错（例如把通知写成 bail）。这里挂到 `internal/dispatch` 上，
 * 只在实际派发模式与声明不符时告警，不影响生产构建、也不改变返回值。
 */
export function auditEventModes(ctx: Context): void {
  ctx.on('internal/dispatch', (mode, name) => {
    if (typeof name !== 'string') return
    if (!Object.hasOwn(EVENT_MODES, name)) return
    const expected = EVENT_MODES[name as keyof typeof EVENT_MODES]
    if (expected === mode) return
    ctx
      .logger('events')
      .warn(`事件 ${name} 声明为 ${expected}，实际以 ${mode} 派发（见 @mics/sdk/contract/events）`)
  })
}
