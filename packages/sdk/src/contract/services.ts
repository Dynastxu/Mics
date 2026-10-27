import type { Component } from 'vue'
import type { Context } from 'cordis'
import type { Permission, PluginId } from './manifest'
import type { AppInfo, CommandInfo, PluginInfo, RuntimeEventEnvelope, RuntimeSnapshot } from './runtime'

export type MaybePromise<T> = T | Promise<T>

/**
 * 插件作用域上的插件 id。
 *
 * 必须用 Symbol 键：cordis 的 Context 是代理，访问未注册的字符串属性会被
 * 当成「服务」解析，在没有该服务的上下文里读取会抛
 * `cannot get property "pluginId" without inject`。Symbol 属性则直接放行。
 */
export const PLUGIN_ID: unique symbol = Symbol.for('mics.plugin-id') as never

/** 读取当前上下文所属插件 id；不属于任何插件时返回 undefined（例如 shell 根上下文） */
export function pluginIdOf(ctx: Context): PluginId | undefined {
  return (ctx as unknown as Record<symbol, PluginId | undefined>)[PLUGIN_ID]
}

/** 与 cordis 一致的 disposer 形态：调用即释放 */
export type Disposable = () => void

export function toDisposable(dispose: () => void): Disposable {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    dispose()
  }
}

// ---------------------------------------------------------------------------
// IPC：渲染进程 -> 主进程插件方法调用；双向事件
// ---------------------------------------------------------------------------

export interface IpcMeta {
  target: PluginId
  method: string
  callerId?: PluginId
}

export interface IpcServiceApi {
  /** 渲染进程：调用主进程插件暴露的方法 */
  invoke<T = unknown>(target: PluginId, method: string, params?: unknown): Promise<T>
  /** 主进程：注册方法（渲染端也可用，用于渲染端插件之间互调） */
  handle<T = unknown>(
    method: string,
    handler: (params: T, meta: IpcMeta) => MaybePromise<unknown>,
  ): Disposable
  /** 订阅事件（两个进程都能用） */
  on(topic: string, listener: (payload: unknown, envelope: RuntimeEventEnvelope) => void): Disposable
  /** 广播事件 */
  emit(topic: string, payload?: unknown): void
  /** 主进程：广播事件并标注来源插件 */
  broadcast(topic: string, payload?: unknown, source?: PluginId): void
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export interface Command {
  id: string
  title?: string
  category?: string
  keybinding?: string
  handler: (...args: any[]) => MaybePromise<unknown>
}

export interface CommandsServiceApi {
  register(command: Command): Disposable
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>
  list(): CommandInfo[]
  has(id: string): boolean
}

// ---------------------------------------------------------------------------
// 插件宿主
// ---------------------------------------------------------------------------

export interface PluginsServiceApi {
  list(): PluginInfo[]
  get(id: PluginId): PluginInfo | undefined
  /** 激活（用户显式操作或首次使用时由宿主调用）；被禁用的插件会拒绝激活 */
  activate(id: PluginId): Promise<void>
  /** 禁用：持久化到 userData，卸载代码，之后不会被任何事件自动激活 */
  disable(id: PluginId): Promise<void>
  /** 启用：解除禁用并激活 */
  enable(id: PluginId): Promise<void>
  /** 主进程实现：激活所有声明了 onStartup / * 的插件 */
  activateStartup?(): Promise<void>
  /** 渲染端实现：重新拉取内核快照 */
  refresh?(): Promise<void>
  snapshot(): RuntimeSnapshot
  /** 渲染端实现：插件作用域上下文，供视图组件通过 provide 使用 */
  contextOf?(id: PluginId): Context | undefined
  onDidChange(listener: () => void): Disposable
}

// ---------------------------------------------------------------------------
// 存储 / 权限
// ---------------------------------------------------------------------------

export interface StorageServiceApi {
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
}

export interface PermissionsServiceApi {
  has(permission: Permission | string): boolean
  require(permission: Permission | string): void
  allows(pluginId: PluginId | undefined, permission: Permission | string): boolean
}

// ---------------------------------------------------------------------------
// 渲染端服务
// ---------------------------------------------------------------------------

export interface RendererStatusBarItem {
  id: string
  text: string
  alignment?: 'left' | 'right'
  order?: number
  tooltip?: string
  command?: string
}

export interface UiServiceApi {
  registerView(viewId: string, component: Component): Disposable
  registerStatusBarItem(item: RendererStatusBarItem): Disposable
  componentOf(viewId: string): Component | undefined
}

export interface ThemeServiceApi {
  apply(themeId: string): void
  /** 渲染端：启动时从 localStorage 恢复主题 */
  restore(): void
  current(): string | undefined
  available(): { id: string; label: string }[]
}

export interface BridgeApi {
  invoke<T = unknown>(
    target: PluginId,
    method: string,
    params?: unknown,
    callerId?: PluginId,
  ): Promise<T>
  on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): Disposable
  emit(topic: string, payload?: unknown, callerId?: PluginId): void
  readonly versions: Record<string, string>
  readonly platform: string
}

// ---------------------------------------------------------------------------
// 通过模块增强把服务挂到 cordis 的 Context / Events 上
// ---------------------------------------------------------------------------

declare module 'cordis' {
  interface Context {
    plugins: PluginsServiceApi
    ipc: IpcServiceApi
    commands: CommandsServiceApi
    storage: StorageServiceApi
    permissions: PermissionsServiceApi
    ui: UiServiceApi
    theme: ThemeServiceApi
    bridge: BridgeApi
  }

  interface Events {
    'plugins/changed'(): void
    'plugin/activated'(id: PluginId): void
    'plugin/deactivated'(id: PluginId): void
  }
}

export type { AppInfo, CommandInfo, PluginInfo, RuntimeEventEnvelope, RuntimeSnapshot }
