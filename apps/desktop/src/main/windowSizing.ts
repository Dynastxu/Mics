import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { MicsWindowResizeGesture } from '@mics/sdk'

/**
 * 窗口尺寸策略：最小尺寸、启动尺寸，以及状态栏拖动区的缩放计算。
 *
 * 窗口是无边框的，状态栏右下角的拖动区是随手改大小的地方：渲染进程只上报
 * 指针的屏幕坐标，起始 bounds 与夹取规则都留在主进程。
 */
export const MIN_WINDOW_SIZE = { width: 640, height: 420 } as const

/** 启动尺寸：默认值，屏幕装不下时按工作区收缩 */
export const DEFAULT_WINDOW_SIZE = { width: 1320, height: 860 } as const

/** 启动尺寸与工作区之间保留的余量，避免窗口贴住屏幕边缘 */
const SCREEN_MARGIN = 80

export function isResizeGesture(value: unknown): value is MicsWindowResizeGesture {
  if (!value || typeof value !== 'object') return false
  const gesture = value as Partial<MicsWindowResizeGesture>
  return (
    (gesture.phase === 'start' || gesture.phase === 'move' || gesture.phase === 'end') &&
    Number.isFinite(gesture.x) &&
    Number.isFinite(gesture.y)
  )
}

/**
 * 启动尺寸：默认尺寸与工作区取小，再退回最小尺寸。
 * 小屏幕上不会出现「窗口比屏幕还大」的情况。
 */
export function initialWindowSize(): { width: number; height: number } {
  const work = screen.getPrimaryDisplay().workArea
  const fit = (wanted: number, available: number, min: number): number =>
    Math.max(min, Math.min(wanted, available))
  return {
    width: fit(DEFAULT_WINDOW_SIZE.width, work.width - SCREEN_MARGIN, MIN_WINDOW_SIZE.width),
    height: fit(DEFAULT_WINDOW_SIZE.height, work.height - SCREEN_MARGIN, MIN_WINDOW_SIZE.height),
  }
}

interface ResizeSession {
  window: BrowserWindow
  /** 按下时的指针屏幕坐标 */
  startX: number
  startY: number
  /** 按下时的窗口 bounds：左上角固定，尺寸随指针增量变化 */
  bounds: Rectangle
}

let session: ResizeSession | null = null

/** 按下：记下起点；最大化时先还原，再按还原后的尺寸继续拖 */
export function beginResize(window: BrowserWindow, x: number, y: number): void {
  if (window.isDestroyed() || window.isFullScreen()) return
  if (window.isMaximized()) window.unmaximize()

  session = { window, startX: x, startY: y, bounds: window.getNormalBounds() }
}

/** 拖动：右下角跟随指针，只受最小尺寸限制，左上角保持不动 */
export function moveResize(window: BrowserWindow, x: number, y: number): void {
  if (!session || session.window !== window) return

  const { bounds, startX, startY } = session
  window.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: resized(bounds.width, x - startX, MIN_WINDOW_SIZE.width),
    height: resized(bounds.height, y - startY, MIN_WINDOW_SIZE.height),
  })
}

function resized(start: number, delta: number, min: number): number {
  return Math.max(min, Math.round(start + delta))
}

/** 松开：结束这次拖动 */
export function endResize(window: BrowserWindow): void {
  if (session?.window === window) session = null
}
