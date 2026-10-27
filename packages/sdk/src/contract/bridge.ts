import type { PluginId } from './manifest'
import type { RuntimeEventEnvelope } from './runtime'

/** 自定义标题栏发出的窗口控制指令 */
export type MicsWindowControl = 'minimize' | 'toggle-maximize' | 'close'

/** 窗口状态：标题栏据此在「最大化 / 还原」之间切换图标 */
export interface MicsWindowState {
  maximized: boolean
}

/**
 * 窗口控制：窗口是无边框的（`frame: false`），标题栏由渲染进程自绘，
 * 因此最小化 / 最大化 / 关闭必须经由主进程操作 BrowserWindow。
 *
 * 属于壳层能力，插件不要调用——插件拿不到也不该承担窗口装饰。
 */
export interface MicsWindowControls {
  minimize(): void
  toggleMaximize(): void
  close(): void
  /** 读取当前状态：渲染进程重载时事件可能早于监听，需要主动拉一次 */
  getState(): Promise<MicsWindowState>
  /** 订阅最大化状态变化；返回取消订阅函数 */
  onStateChange(listener: (state: MicsWindowState) => void): () => void
}

/** preload 通过 contextBridge 暴露到渲染进程的 window.mics */
export interface MicsBridge {
  readonly versions: Record<string, string>
  readonly platform: string
  readonly windowControls: MicsWindowControls
  readonly rpc: {
    invoke<T = unknown>(
      target: PluginId,
      method: string,
      params?: unknown,
      callerId?: PluginId,
    ): Promise<T>
  }
  readonly events: {
    on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): () => void
    emit(topic: string, payload?: unknown, callerId?: PluginId): void
  }
}
