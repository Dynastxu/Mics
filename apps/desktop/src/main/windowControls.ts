import { BrowserWindow, ipcMain } from 'electron'
import type { MicsWindowControl, MicsWindowResizeGesture, MicsWindowState } from '@mics/sdk'
import { beginResize, endResize, isResizeGesture, moveResize } from './windowSizing'

const CONTROL_CHANNEL = 'mics:window-control'
const RESIZE_CHANNEL = 'mics:window-resize'
const STATE_CHANNEL = 'mics:window-state'

function stateOf(window: BrowserWindow | null): MicsWindowState {
  return {
    maximized: window?.isMaximized() ?? false,
    // 最小化的窗口仍算「可见」，但用户看不到内容，不能当作可播放
    visible: window ? window.isVisible() && !window.isMinimized() : false
  }
}

/**
 * 自绘标题栏与状态栏拖动区的窗口控制通道。
 *
 * 渲染进程只发意图（最小化 / 切换最大化 / 关闭 / 拖动缩放），真正的窗口
 * 操作留在主进程；一律作用于发消息的那个窗口，而不是某个被捕获的实例。
 */
export function registerWindowControls(): void {
  ipcMain.on(CONTROL_CHANNEL, (event, action: MicsWindowControl) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    switch (action) {
      case 'minimize':
        window.minimize()
        break
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        break
      case 'close':
        window.close()
        break
    }
  })

  ipcMain.on(RESIZE_CHANNEL, (event, gesture: MicsWindowResizeGesture) => {
    if (!isResizeGesture(gesture)) return
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    switch (gesture.phase) {
      case 'start':
        beginResize(window, gesture.x, gesture.y)
        break
      case 'move':
        moveResize(window, gesture.x, gesture.y)
        break
      case 'end':
        endResize(window)
        break
    }
  })

  ipcMain.handle(STATE_CHANNEL, (event) => stateOf(BrowserWindow.fromWebContents(event.sender)))
}

/** 把窗口状态推给渲染进程：双击拖动区、Win+↑、系统菜单、显示 / 隐藏都会改变它 */
export function trackWindowState(window: BrowserWindow): void {
  const push = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(STATE_CHANNEL, stateOf(window))
  }

  window.on('maximize', push)
  window.on('unmaximize', push)
  // 入场动画要等窗口真的显示出来再播：渲染进程靠 visible 判断，不能猜 document.visibilityState
  window.on('show', push)
  window.on('hide', push)
  window.on('minimize', push)
  window.on('restore', push)
  // 拖动中失去焦点（切换应用、窗口被关闭）时丢弃这次拖动，避免继续改大小
  window.on('blur', () => endResize(window))
  window.on('closed', () => endResize(window))
}
