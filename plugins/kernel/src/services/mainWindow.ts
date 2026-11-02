import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Disposable, MainWindowHostApi, MainWindowServiceApi, MainWindowState } from '@mics/sdk'

/**
 * 主窗口生命周期服务。
 *
 * 窗口本身由 bootstrap 创建（见 `apps/desktop/src/main/mainWindowHost.ts`），
 * 内核只把宿主桥接包装成 cordis 服务，让插件通过 `inject: ['mainWindow']`
 * 使用，而不需要 import Electron 或复制窗口配置。
 *
 * 监听器通过 `this.ctx.effect()` 挂在调用方插件 fiber 上：插件卸载时自动撤销。
 */
export class MainWindowService extends Service implements MainWindowServiceApi {
  static inject: string[] = []

  private readonly bridge?: MainWindowHostApi

  constructor(ctx: Context, bridge?: MainWindowHostApi) {
    super(ctx, 'mainWindow')
    this.bridge = bridge
  }

  get supported(): boolean {
    return this.bridge !== undefined
  }

  state(): MainWindowState {
    return this.bridge?.state() ?? { exists: false, visible: false, minimized: false }
  }

  async show(options?: { restore?: boolean }): Promise<void> {
    if (!this.bridge) throw new Error('宿主不支持主窗口生命周期')
    await this.bridge.show(options)
  }

  hide(): boolean {
    return this.bridge?.hide() ?? false
  }

  destroy(options?: { keepAlive?: boolean }): boolean {
    return this.bridge?.destroy(options) ?? false
  }

  onCloseRequest(handler: () => boolean): Disposable {
    if (!this.bridge) return () => {}
    const off = this.bridge.onCloseRequest(handler)
    return this.ctx.effect(() => off)
  }

  onDidChange(listener: (state: MainWindowState) => void): Disposable {
    if (!this.bridge) return () => {}
    const off = this.bridge.onDidChange(listener)
    return this.ctx.effect(() => off)
  }
}
