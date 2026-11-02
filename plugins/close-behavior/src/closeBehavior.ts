import { app } from 'electron'
import type { Logger } from 'cordis'
import type { MainWindowServiceApi, MainWindowState } from '@mics/sdk'
import { TrayController } from './tray'
import type { CloseAction, ClosePromptResult } from './shared'

export interface CloseBehaviorOptions {
  /** 当前生效的关闭行为；每次关闭都重新读，设置页改完立即生效 */
  resolveAction(): CloseAction
  /** 渲染端的内部确认框；返回 undefined 表示界面没有响应 */
  prompt(): Promise<ClosePromptResult | undefined>
  /** 「不再提示」勾选后写回设置 */
  rememberAction(action: CloseAction): void
  /** 低内存托盘：隐藏时销毁主窗口，恢复时重建 */
  lowMemoryTray(): boolean
  /** 主窗口生命周期（宿主提供；插件不直接操作 BrowserWindow） */
  window: MainWindowServiceApi
  logger: Logger
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 关闭主窗口时的询问与托盘行为。
 *
 * 关闭请求由宿主的主窗口服务转给这里：返回 false 表示拦下这次关闭，随后自己
 * 决定隐藏、销毁还是退出。低内存托盘模式下用 `destroy({ keepAlive: true })`
 * 销毁主窗口（释放渲染进程），恢复时由 `window.show()` 重建。
 *
 * 动作都放到 `setImmediate` 里执行：宿主在 close 事件里调用本拦截器，直接销毁
 * 窗口会让 close 事件本身处于「窗口已销毁」的状态；先返回 false、下一 tick 再动
 * 窗口更安全。确认框结果本身是异步回调，不需要再延后。
 */
export class CloseBehavior {
  private readonly tray: TrayController
  private offClose?: () => void
  private offState?: () => void

  private prompting = false
  /** 一次关闭请求已经进入处理，避免双击 / 重复 close 触发两次动作 */
  private closing = false
  private quitting = false
  private disposed = false

  constructor(private readonly options: CloseBehaviorOptions) {
    this.tray = new TrayController({
      onShow: this.restore,
      onQuit: () => this.quit('托盘菜单'),
      logger: options.logger
    })
  }

  start(): void {
    this.offClose = this.options.window.onCloseRequest(() => this.handleCloseRequest())
    this.offState = this.options.window.onDidChange((state) => this.handleWindowState(state))
    app.on('before-quit', this.onBeforeQuit)
    // macOS 的 Dock 图标在窗口销毁 / 隐藏时仍然存在，点它应当能恢复窗口
    app.on('activate', this.onActivate)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offClose?.()
    this.offState?.()
    app.off('before-quit', this.onBeforeQuit)
    app.off('activate', this.onActivate)
    this.tray.destroy()

    // 插件被停用后不再有托盘菜单；低内存模式下窗口可能已被销毁，必须重建
    if (this.quitting) return
    const state = this.options.window.state()
    if (state.exists && state.visible) return
    void this.options.window.show().catch((error) => {
      this.options.logger.warn('恢复主窗口失败：%s', messageOf(error))
    })
  }

  private readonly onBeforeQuit = (): void => {
    // 不管是托盘菜单、系统注销还是别处调用 app.quit()，都不再拦截关闭
    this.quitting = true
    this.tray.destroy()
  }

  private readonly onActivate = (): void => {
    const state = this.options.window.state()
    if (!state.exists || !state.visible) this.restore()
  }

  /** 宿主在主窗口 close 时调用；返回 false 阻止这次关闭 */
  private handleCloseRequest(): boolean {
    if (this.quitting || this.disposed) return true

    let action: CloseAction
    try {
      action = this.options.resolveAction()
    } catch (error) {
      this.options.logger.warn('读取关闭行为失败：%s，改为询问', messageOf(error))
      action = 'ask'
    }

    if (action === 'quit' || action === 'tray') {
      if (this.closing) return false
      this.closing = true
      setImmediate(() => {
        this.closing = false
        if (this.disposed || this.quitting) return
        if (action === 'quit') this.quit('关闭行为设置为退出应用')
        else this.minimizeToTray()
      })
      return false
    }

    // 确认框已经打开时再点关闭（或另一个窗口）不叠加第二个框
    if (this.prompting || this.closing) return false
    this.closing = true
    this.prompting = true
    void this.ask().finally(() => {
      this.prompting = false
      this.closing = false
    })
    return false
  }

  private async ask(): Promise<void> {
    // 任务栏关闭 / 窗口最小化时，确认框会渲染在后台窗口里：先恢复并聚焦，
    // 否则用户看不到任何反馈，只会觉得「关不掉」
    await this.reveal()

    let result: ClosePromptResult | undefined
    try {
      result = await this.options.prompt()
    } catch (error) {
      this.options.logger.warn('关闭确认框出错：%s', messageOf(error))
      result = undefined
    }

    // 插件在等待选择期间被停用：不要再隐藏 / 退出窗口
    if (this.disposed || this.quitting) return

    if (!result) {
      // 界面没有响应（或渲染进程已坏）：隐藏到托盘仍可经托盘菜单退出
      this.options.logger.warn('关闭确认框未响应，按最小化至托盘处理')
      this.minimizeToTray()
      return
    }

    if (result.remember) this.remember(result.action)
    if (result.action === 'quit') this.quit('用户在关闭确认框中选择退出')
    else this.minimizeToTray()
  }

  /** 把主窗口恢复到前台；窗口已销毁时不会有 close 请求，直接返回 */
  private async reveal(): Promise<void> {
    if (this.disposed || this.quitting) return
    if (!this.options.window.state().exists) return
    try {
      await this.options.window.show()
      // macOS 上显示窗口不一定会激活应用，补一次应用级激活
      app.focus({ steal: true })
    } catch (error) {
      this.options.logger.warn('关闭前恢复主窗口失败：%s', messageOf(error))
    }
  }

  private remember(action: CloseAction): void {
    try {
      this.options.rememberAction(action)
      this.options.logger.info('已记住关闭行为：%s', action)
    } catch (error) {
      this.options.logger.warn('保存关闭行为失败：%s', messageOf(error))
    }
  }

  /** 隐藏 / 销毁主窗口；返回是否真的离开了可见状态 */
  private minimizeToTray(): boolean {
    if (!this.options.window.state().exists) return false
    if (!this.tray.ensure()) {
      this.options.logger.warn('托盘不可用，保持窗口可见')
      return false
    }

    if (this.options.lowMemoryTray() && this.options.window.supported) {
      if (this.options.window.destroy({ keepAlive: true })) {
        this.options.logger.info('主窗口已销毁（低内存托盘），恢复时重建')
        return true
      }
      this.options.logger.warn('销毁主窗口失败，改为隐藏')
    }

    if (this.options.window.hide()) {
      this.options.logger.info('主窗口已最小化至托盘')
      return true
    }
    this.options.logger.warn('隐藏主窗口失败')
    return false
  }

  private quit(reason: string): void {
    this.quitting = true
    this.tray.destroy()
    this.options.logger.info('退出应用：%s', reason)
    app.quit()
  }

  private readonly restore = (): void => {
    this.options.logger.info('从托盘恢复主窗口')
    void this.options.window.show().catch((error) => {
      this.options.logger.warn('恢复主窗口失败：%s', messageOf(error))
    })
  }

  private handleWindowState(state: MainWindowState): void {
    if (!state.visible) return
    this.tray.destroy()
    // 用户从托盘恢复后允许下一次关闭请求重新走流程
    this.closing = false
  }
}
