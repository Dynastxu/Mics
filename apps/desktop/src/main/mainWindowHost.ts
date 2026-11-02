import type { BrowserWindow } from 'electron'
import type { MainWindowHostApi, MainWindowState } from '@mics/sdk'
import type { LoadRendererOptions, MainWindowOptions } from './window'

export interface MainWindowHostOptions {
  /** 由 bootstrap 注入：保持窗口配置只有一份 */
  createWindow(options: MainWindowOptions): BrowserWindow
  loadRenderer(window: BrowserWindow, options: LoadRendererOptions): Promise<void>
}

/**
 * 主窗口生命周期宿主。
 *
 * bootstrap 是唯一知道「主窗口怎么创建」的地方（无边框、preload、导航拦截、
 * 窗口状态跟踪都在 `createMainWindow` 里），插件不能复制这套配置。这个类把
 * 「创建 / 显示 / 隐藏 / 销毁」暴露给内核的 `mainWindow` 服务，让低内存托盘
 * 模式可以在隐藏时销毁窗口、恢复时重建。
 *
 * `keepAlive` 只在「为托盘主动销毁最后一个窗口」时为 true：`window-all-closed`
 * 据此不退出应用。真正退出（`before-quit`）会把标记清掉。
 */
export class MainWindowHost implements MainWindowHostApi {
  private window: BrowserWindow | null = null
  private creating: Promise<BrowserWindow> | null = null
  private closeHandler: (() => boolean) | null = null
  private readonly listeners = new Set<(state: MainWindowState) => void>()
  private keepAliveMode = false
  private quitting = false
  /** 低内存托盘重建时恢复窗口几何；普通启动没有值 */
  private lastBounds?: MainWindowOptions['bounds']
  private lastMaximized = false

  constructor(private readonly options: MainWindowHostOptions) {}

  state(): MainWindowState {
    const window = this.window && !this.window.isDestroyed() ? this.window : null
    return {
      exists: window !== null,
      visible: window ? window.isVisible() && !window.isMinimized() : false,
      minimized: window?.isMinimized() ?? false
    }
  }

  async show(options: { restore?: boolean } = {}): Promise<void> {
    const window = await this.ensure(options.restore ?? true)
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    // focus() 在部分平台只会让任务栏按钮闪烁；先无条件提到 z 序最前
    try {
      window.moveTop()
    } catch {
      // Wayland 等环境不支持 moveTop
    }
    window.focus()
    this.emit()
  }

  hide(): boolean {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    try {
      window.hide()
    } catch (error) {
      console.error('[mics] 隐藏主窗口失败', error)
      return false
    }
    this.emit()
    return true
  }

  destroy(options: { keepAlive?: boolean } = {}): boolean {
    const window = this.window
    if (!window || window.isDestroyed()) return false

    this.rememberGeometry(window)
    this.keepAliveMode = options.keepAlive ?? false
    try {
      window.destroy()
    } catch (error) {
      console.error('[mics] 销毁主窗口失败', error)
      this.keepAliveMode = false
      return false
    }
    if (this.window === window) this.window = null
    this.emit()
    return true
  }

  onCloseRequest(handler: () => boolean): () => void {
    this.closeHandler = handler
    return () => {
      if (this.closeHandler === handler) this.closeHandler = null
    }
  }

  onDidChange(listener: (state: MainWindowState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** `window-all-closed` 是否应保持运行：为托盘销毁了最后一个窗口 */
  shouldKeepAlive(): boolean {
    return this.keepAliveMode && !this.quitting
  }

  /** `before-quit`：退出流程不再拦截关闭，也不保持后台 */
  prepareQuit(): void {
    this.quitting = true
    this.keepAliveMode = false
  }

  private async ensure(restore: boolean): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window
    if (this.creating) return this.creating

    this.creating = this.create(restore).finally(() => {
      this.creating = null
    })
    return this.creating
  }

  private async create(restore: boolean): Promise<BrowserWindow> {
    // 从低内存托盘恢复时 keepAlive 还是 true；创建失败要恢复它，否则窗口
    // 销毁触发的 window-all-closed 会把仍在托盘里的应用一起退出
    const wasKeepAlive = this.keepAliveMode
    const window = this.options.createWindow({
      bounds: this.lastBounds,
      maximized: this.lastMaximized
    })
    this.window = window
    // 新窗口存在时不再需要 window-all-closed 的保活标记
    this.keepAliveMode = false
    this.attach(window)

    try {
      await this.options.loadRenderer(window, { restore })
    } catch (error) {
      // 先恢复保活标记再销毁窗口：window-all-closed 可能同步触发
      this.keepAliveMode = wasKeepAlive
      if (this.window === window) this.window = null
      try {
        if (!window.isDestroyed()) window.destroy()
      } catch {
        // 加载失败时窗口可能已经被销毁
      }
      this.emit()
      throw error
    }

    this.emit()
    return window
  }

  private attach(window: BrowserWindow): void {
    const onClose = (event: Electron.Event): void => {
      // before-quit / 注销关机之后不再拦关闭
      if (this.quitting) return

      const handler = this.closeHandler
      if (!handler) return
      let allow = true
      try {
        allow = handler()
      } catch (error) {
        // 拦截器自身出错时退回默认关闭，避免窗口永远关不掉
        console.error('[mics] 主窗口关闭拦截器失败', error)
      }
      if (!allow) event.preventDefault()
    }
    const onChange = (): void => this.emit()
    const onSessionEnd = (): void => {
      this.quitting = true
      this.keepAliveMode = false
      this.emit()
    }

    window.on('close', onClose)
    window.on('show', onChange)
    window.on('hide', onChange)
    window.on('minimize', onChange)
    window.on('restore', onChange)
    window.on('query-session-end', onSessionEnd)
    window.on('session-end', onSessionEnd)
    window.on('closed', () => {
      if (this.window === window) this.window = null
      this.emit()
    })
  }

  private rememberGeometry(window: BrowserWindow): void {
    try {
      const maximized = window.isMaximized()
      // 最大化时保存还原后的尺寸，恢复时再 maximize，避免把最大化 bounds 当普通尺寸
      this.lastBounds = maximized ? window.getNormalBounds() : window.getBounds()
      this.lastMaximized = maximized
    } catch {
      // 窗口可能已经销毁：保留上一次的值
    }
  }

  private emit(): void {
    const state = this.state()
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error) {
        console.error('[mics] 主窗口状态监听失败', error)
      }
    }
  }
}
