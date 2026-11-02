import { app, BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { trackWindowState } from './windowControls'
import { initialWindowSize, MIN_WINDOW_SIZE } from './windowSizing'

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

export interface MainWindowOptions {
  /** 从低内存托盘重建时恢复上次的位置与大小 */
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}

/** 把上次的窗口 bounds 夹到当前显示器工作区：换显示器 / 拔掉副屏时不会跑到屏幕外 */
function restoreBounds(
  bounds?: MainWindowOptions['bounds']
): MainWindowOptions['bounds'] | undefined {
  if (!bounds) return undefined
  const work = screen.getDisplayMatching(bounds).workArea
  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(bounds.width, work.width))
  const height = Math.max(MIN_WINDOW_SIZE.height, Math.min(bounds.height, work.height))
  return {
    x: Math.max(work.x, Math.min(bounds.x, work.x + work.width - width)),
    y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)),
    width,
    height
  }
}

export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
  const size = initialWindowSize()
  const restored = restoreBounds(options.bounds)
  const window = new BrowserWindow({
    width: restored?.width ?? size.width,
    height: restored?.height ?? size.height,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
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
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    // maximize() 会显示窗口；等第一帧就绪再执行，避免白屏闪烁
    if (options.maximized) window.maximize()
    window.show()
  })
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

export interface LoadRendererOptions {
  /**
   * 从托盘恢复：让渲染端带上 `restore=1`，把上次打开的页面恢复回来。
   * bootstrap 首次启动不传，仍按布局的 defaultView 打开。
   */
  restore?: boolean
}

export async function loadRenderer(
  window: BrowserWindow,
  options: LoadRendererOptions = {}
): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = options.restore ? `${devUrl}${devUrl.includes('?') ? '&' : '?'}restore=1` : devUrl
    await window.loadURL(url)
  } else {
    const file = path.join(import.meta.dirname, '../renderer/index.html')
    await window.loadFile(file, options.restore ? { query: { restore: '1' } } : undefined)
  }
}
