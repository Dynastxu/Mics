import { app, Menu, Tray } from 'electron'
import type { Logger } from 'cordis'
import { trayImage } from './trayIcon'

export interface TrayControllerOptions {
  /** 托盘菜单 / 单击图标：恢复主窗口 */
  onShow(): void
  /** 托盘菜单：退出应用 */
  onQuit(): void
  logger: Logger
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 托盘图标的生命周期。
 *
 * 只负责「创建 / 销毁图标与菜单」，不决定什么时候隐藏窗口；隐藏与恢复由
 * `CloseBehavior` 编排。创建失败时返回 false，调用方保持窗口可见，避免应用
 * 失去唯一的入口。
 */
export class TrayController {
  private tray: Tray | undefined

  constructor(private readonly options: TrayControllerOptions) {}

  ensure(): boolean {
    if (this.tray) return true

    let tray: Tray | undefined
    try {
      tray = new Tray(trayImage())
      tray.setToolTip(app.getName())
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示主界面', click: () => this.options.onShow() },
          { type: 'separator' },
          { label: '退出应用', click: () => this.options.onQuit() }
        ])
      )
      // 右键菜单在三个平台都可用；Windows 用户习惯单击图标直接恢复
      if (process.platform === 'win32') tray.on('click', () => this.options.onShow())

      this.tray = tray
      return true
    } catch (error) {
      this.options.logger.warn('创建托盘图标失败：%s', messageOf(error))
      try {
        tray?.destroy()
      } catch {
        // 图标可能已经随构造失败一起销毁
      }
      return false
    }
  }

  destroy(): void {
    const tray = this.tray
    if (!tray) return
    this.tray = undefined
    try {
      tray.destroy()
    } catch {
      // 托盘可能已经被系统销毁（例如注销过程中）
    }
  }
}
