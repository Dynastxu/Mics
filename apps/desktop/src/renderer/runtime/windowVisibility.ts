import type { IconPlaybackGate } from '@mics/ui'

/**
 * 窗口可见性：入场动画的播放门。
 *
 * 窗口是 `show: false` 创建、`ready-to-show` 之后才显示的；这段时间 Electron 默认
 * 仍然绘制隐藏窗口，所以 `document.visibilityState` 并不可靠。真正知道窗口有没有
 * 显示出来的只有主进程：这里把 `windowControls` 的窗口状态接成一个播放门，
 * 供 @mics/ui 的图标在启动动画前等待。
 */

/** 迟迟等不到窗口可见时的兜底：宁可晚播，也不能让图标停在动画开始前的空状态 */
const FALLBACK_MS = 3000

let visible = false
let tracking = false
const waiting = new Set<() => void>()

function update(next: boolean): void {
  if (next === visible) return
  visible = next
  if (!visible) return
  for (const listener of [...waiting]) listener()
}

export function startWindowVisibilityTracking(): void {
  if (tracking) return
  tracking = true

  const controls = window.mics?.windowControls
  if (!controls) {
    // 不在 Electron 里（例如组件预览）：没有窗口概念，直接放行
    update(true)
    return
  }

  // visible 缺失时按「可见」处理，避免旧主进程让图标一直停在待播状态
  controls.onStateChange((state) => update(state.visible !== false))
  void controls
    .getState()
    .then((state) => update(state.visible !== false))
    .catch(() => update(true))
}

/** 播放门：等主进程确认窗口真的显示出来，再开始图标动画 */
export const windowVisibilityGate: IconPlaybackGate = {
  whenVisible(run: () => void): () => void {
    if (visible) {
      run()
      return () => {}
    }

    let settled = false
    const start = (): void => {
      if (settled) return
      settled = true
      waiting.delete(start)
      clearTimeout(timer)
      run()
    }
    waiting.add(start)
    const timer = setTimeout(start, FALLBACK_MS)

    return (): void => {
      settled = true
      waiting.delete(start)
      clearTimeout(timer)
    }
  }
}
