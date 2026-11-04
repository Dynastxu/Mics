import type { PluginId } from './manifest'
import type { RuntimeEventEnvelope } from './runtime'

/** 自定义标题栏发出的窗口控制指令 */
export type MicsWindowControl = 'minimize' | 'toggle-maximize' | 'close'

/** 拖动缩放的阶段：按下 / 拖动 / 松开 */
export type MicsWindowResizePhase = 'start' | 'move' | 'end'

/**
 * 状态栏拖动缩放的指针位置。
 *
 * 使用屏幕坐标（DIP）：百分比与像素都不需要渲染进程参与计算，
 * 主进程拿它和窗口的起始 bounds 相加即可，指针跑出窗口也不会漂移。
 */
export interface MicsWindowResizeGesture {
  phase: MicsWindowResizePhase
  x: number
  y: number
}

/** 窗口状态：标题栏据此在「最大化 / 还原」之间切换图标，渲染进程据此决定何时播放入场动画 */
export interface MicsWindowState {
  maximized: boolean
  /**
   * 窗口是否真的显示在屏幕上。
   *
   * 窗口是 `show: false` 创建、`ready-to-show` 之后才显示的，这段时间里的
   * `document.visibilityState` 并不可靠（Electron 默认会在隐藏时也绘制），
   * 所以「是否可见」只能由主进程回答。
   */
  visible: boolean
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
  /** 按住状态栏右下角的拖动区缩放窗口：按下发 start，移动发 move，松开发 end */
  resizeWindow(gesture: MicsWindowResizeGesture): void
  /** 读取当前状态：渲染进程重载时事件可能早于监听，需要主动拉一次 */
  getState(): Promise<MicsWindowState>
  /** 订阅窗口状态变化（最大化、显示 / 隐藏、最小化 / 还原）；返回取消订阅函数 */
  onStateChange(listener: (state: MicsWindowState) => void): () => void
}

/** preload 通过 contextBridge 暴露到渲染进程的 window.mics */
export interface MicsBridge {
  /** 当前渲染进程所属窗口的 webContents id；事件路由用它区分"发给哪个窗口" */
  readonly windowId: number
  readonly versions: Record<string, string>
  readonly platform: string
  readonly windowControls: MicsWindowControls
  readonly rpc: {
    invoke<T = unknown>(
      target: PluginId,
      method: string,
      params?: unknown,
      callerId?: PluginId
    ): Promise<T>
  }
  readonly events: {
    on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): () => void
    emit(topic: string, payload?: unknown, callerId?: PluginId): void
  }
}
