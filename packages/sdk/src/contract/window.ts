/**
 * 主窗口生命周期。
 *
 * 主窗口由 bootstrap 创建（无边框、preload、导航拦截、窗口状态跟踪都在那里），
 * 插件不能自己 `new BrowserWindow()` 复制一遍。低内存托盘模式需要「销毁窗口
 * 释放渲染进程，恢复时重建」，因此宿主把创建 / 销毁 / 关闭请求的能力通过这个
 * 接口暴露出来；内核把它包装成 `ctx.mainWindow` 服务。
 *
 * `window-all-closed` / `before-quit` 仍由 bootstrap 处理：销毁窗口时传
 * `keepAlive: true`，宿主据此不退出应用；真正退出时 `before-quit` 会清掉这个标记。
 */
export interface MainWindowState {
  exists: boolean
  visible: boolean
  minimized: boolean
}

export interface MainWindowHostApi {
  state(): MainWindowState

  /**
   * 显示主窗口；不存在时创建并加载渲染进程。
   *
   * `restore: true`（默认）用于从托盘恢复：渲染端会带上 `restore=1` 启动，
   * 恢复上次打开的页面；bootstrap 首次启动传 `false`，仍按布局的默认页面打开。
   */
  show(options?: { restore?: boolean }): Promise<void>

  /** 隐藏主窗口，不销毁渲染进程；返回是否成功 */
  hide(): boolean

  /**
   * 销毁主窗口以释放渲染进程。
   *
   * `keepAlive: true` 时 `window-all-closed` 不退出应用（低内存托盘）；
   * 缺省 / false 时按正常关闭处理。
   */
  destroy(options?: { keepAlive?: boolean }): boolean

  /**
   * 注册主窗口关闭请求拦截器。
   *
   * 返回 `false` 阻止这次关闭（插件随后自行隐藏 / 销毁 / 退出）；返回 `true`
   * 放行。宿主在 `before-quit` 之后不再调用它，避免退出流程被拦下。
   */
  onCloseRequest(handler: () => boolean): () => void

  /** 订阅主窗口创建 / 销毁 / 显示 / 隐藏 / 最小化 / 还原 */
  onDidChange(listener: (state: MainWindowState) => void): () => void
}

export interface MainWindowServiceApi extends MainWindowHostApi {
  /** 宿主是否提供窗口生命周期；测试或其它嵌入环境可能为 false */
  readonly supported: boolean
}
