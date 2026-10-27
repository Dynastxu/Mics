import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { trackWindowState } from './windowControls'

/** 没有系统菜单后，开发期常用快捷键在这里补回来（生产构建不注册） */
function registerDevShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()

    if (input.key === 'F12' || ((input.control || input.meta) && input.shift && key === 'i')) {
      event.preventDefault()
      window.webContents.toggleDevTools()
      return
    }
    if ((input.control || input.meta) && key === 'r') {
      event.preventDefault()
      window.webContents.reload()
    }
  })
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 标题栏与窗口按钮由渲染器自绘（shell/WindowTitleBar.vue）
    frame: false,
    backgroundColor: '#0f1115',
    title: 'Mics',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  trackWindowState(window)
  if (!app.isPackaged) registerDevShortcuts(window)

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = url.startsWith('file://') || Boolean(devUrl && url.startsWith(devUrl))
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  return window
}

export async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    await window.loadURL(devUrl)
  } else {
    await window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}
