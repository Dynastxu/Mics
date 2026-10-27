import { BrowserWindow, ipcMain } from 'electron'
import type { MicsWindowControl, MicsWindowState } from '@mics/sdk'

const CONTROL_CHANNEL = 'mics:window-control'
const STATE_CHANNEL = 'mics:window-state'

function stateOf(window: BrowserWindow | null): MicsWindowState {
  return { maximized: window?.isMaximized() ?? false }
}

/**
 * 自绘标题栏的窗口控制通道。
 *
 * 渲染进程只发意图（最小化 / 切换最大化 / 关闭），真正的窗口操作留在主进程；
 * 一律作用于发消息的那个窗口，而不是某个被捕获的实例。
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

  ipcMain.handle(STATE_CHANNEL, (event) => stateOf(BrowserWindow.fromWebContents(event.sender)))
}

/** 把最大化状态推给渲染进程：双击拖动区、Win+↑、系统菜单都会改变它 */
export function trackWindowState(window: BrowserWindow): void {
  const push = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(STATE_CHANNEL, stateOf(window))
  }

  window.on('maximize', push)
  window.on('unmaximize', push)
}
