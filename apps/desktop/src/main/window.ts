import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
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
