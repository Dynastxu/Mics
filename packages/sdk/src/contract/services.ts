import type { Component } from 'vue'
import type { Context } from 'cordis'
// 只取类型：插件用 `ctx.timeout/interval`，实现由根上下文挂载的 TimerService 提供
import type {} from '@cordisjs/plugin-timer'
import type { CapabilitiesServiceApi } from './capability'
import type { PluginConfigurationInfo } from './configuration'
import type { PluginGraphReport } from './diagnostics'
import type { Permission, PluginId } from './manifest'
import type { PluginFailureStage, PluginInstallSummary } from './plugins'
import type {
  AppInfo,
  CommandInfo,
  PluginInfo,
  RuntimeEventEnvelope,
  RuntimeSnapshot
} from './runtime'
import type { MainWindowServiceApi } from './window'
import type { WirePayload, WireTopic } from './topics'

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
    handler: (params: T, meta: IpcMeta) => MaybePromise<unknown>
  ): Disposable
  /**
   * 订阅跨进程事件（两个进程都能用）。
   *
   * 推荐用契约 topic（`ipc:` 前缀），payload 类型由 `RuntimeEvents` 增补给出；
   * 字符串重载只留给基础设施代码（内核转发、桥接层）。
   */
  on<K extends WireTopic>(
    topic: K,
    listener: (payload: WirePayload<K>, envelope: RuntimeEventEnvelope) => void
  ): Disposable
  on(
    topic: string,
    listener: (payload: unknown, envelope: RuntimeEventEnvelope) => void
  ): Disposable
  /**
   * 广播事件。
   *
   * `ipc:` 前缀的 topic 会在本地再派发一次同名 Cordis 事件，
   * 因此插件用 `ctx.on('ipc:...')` 就能同时收到本进程与另一进程的广播。
   */
  emit<K extends WireTopic>(topic: K, payload: WirePayload<K>): void
  emit(topic: string, payload?: unknown): void
  /**
   * 主进程：广播事件并标注来源插件。
   *
   * `target` 是目标窗口的 webContents id；省略表示广播给所有窗口。
   * 多窗口时"只属于某个窗口"的事件（关闭确认框、通知）应当带上它。
   */
  broadcast<K extends WireTopic>(
    topic: K,
    payload: WirePayload<K>,
    source?: PluginId,
    target?: number
  ): void
  broadcast(topic: string, payload?: unknown, source?: PluginId, target?: number): void
  /** 主进程实现：某个插件注册的方法名（诊断用） */
  methodsOf?(target: PluginId): string[]
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
  /**
   * 重载：停掉旧代码，重新导入并挂载。
   *
   * 主进程与渲染端各实现一半；调用方必须先卸掉页面再调用主进程这一半，
   * 否则会出现「一半新一半旧」。
   */
  reload?(id: PluginId): Promise<void>
  /** 渲染端实现：只卸掉页面、样式与作用域，不改插件状态 */
  unload?(id: PluginId): Promise<void>
  /** 主进程实现：把插件标记为失败（渲染端加载出错时由渲染端回报） */
  fail?(id: PluginId, message: string, stage?: PluginFailureStage): Promise<void>
  /** 主进程实现：读取文件夹里的清单，生成安装确认摘要（不落盘） */
  inspect?(dir: string): Promise<PluginInstallSummary>
  /**
   * 主进程实现：依赖图 + 贡献点 + 未满足项。
   *
   * 只读诊断：插件管理页与 agent 共用同一份数据，不各自推断。
   */
  diagnostics?(): PluginGraphReport | Promise<PluginGraphReport>
  /** 主进程实现：把文件夹安装到用户插件目录，成功后默认禁用 */
  install?(dir: string): Promise<{ plugin: PluginInstallSummary; upgraded: boolean }>
  /** 主进程实现：卸载（停用 + 卸载脚本 + 删除本体），内置插件会被拒绝 */
  uninstall?(id: PluginId, options?: { force?: boolean }): Promise<void>
  /** 主进程实现：激活所有声明了 onStartup / * 的插件 */
  activateStartup?(): Promise<void>
  /**
   * 主进程实现：挂载整棵插件树（include 引擎）。
   * 必须在 `ipc` 等服务就绪后调用，否则 inject 这些服务的插件会一直 pending。
   */
  mountPlugins?(): Promise<void>
  /** 渲染端实现：重新拉取内核快照 */
  refresh?(): Promise<void>
  /** 渲染端实现：快照落地后 resolve（服务本身在 init 完成前就可注入） */
  whenReady?(): Promise<void>
  /** 渲染端实现：加载所有启用插件的渲染半边（在 plugins 服务就绪之后调用） */
  activateAll?(): Promise<void>
  snapshot(): RuntimeSnapshot
  /** 渲染端实现：插件作用域上下文，供页面组件通过 provide 使用 */
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
// 配置：清单 schema + 当前值，设置页与 agent 共用
// ---------------------------------------------------------------------------

export interface ConfigurationServiceApi {
  /** 所有声明了 `contributes.configuration` 的插件 */
  list(): PluginConfigurationInfo[]
  /** 某个插件的 schema 与当前生效值；没有 schema 时返回 undefined */
  describe(pluginId: PluginId): PluginConfigurationInfo | undefined
  /** 校验并写入用户值；返回更新后的描述 */
  set(pluginId: PluginId, key: string, value: unknown): PluginConfigurationInfo
  /** 删除用户值，回退到 profile / schema 默认值 */
  reset(pluginId: PluginId, key: string): PluginConfigurationInfo
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

/** 通用设置页的视图 id；没有页面 id 概念的旧 section 默认挂在这里 */
export const GENERAL_SETTINGS_PAGE = 'settings.general'

/**
 * 追加到某个基础设置模板（`SettingsPage`）的分组。
 *
 * 插件在渲染端 `apply()` 里注册；分组组件通常直接返回一个 `<SettingsGroup>`，
 * 自己决定标题、错误提示和行的布局。渲染时 shell 会把注册方的作用域注入进去，
 * 组件里可以直接 `usePluginContext()`，不会误用宿主页面的上下文。
 */
export interface SettingsGroupRegistration {
  /** 同一页面内唯一；跨插件重复会注册失败 */
  id: string
  /** 追加到哪个设置页；与 `contributes.nav[].id` 一致，如 settings.general */
  pageId: string
  /** 诊断与排序用的标题；实际标题由分组组件渲染 */
  title?: string
  /** 同页追加顺序，缺省 100 */
  order?: number
  component: Component
  props?: Record<string, unknown>
}

/** 已注册的分组：注册信息 + 注册方归属与作用域 */
export interface SettingsGroupContribution extends SettingsGroupRegistration {
  /** 注册方插件 id */
  pluginId?: PluginId
  /**
   * 注册方作用域；渲染端用它给分组提供 usePluginContext()。
   * 类型保持 unknown：这份数据会进 reactive store，cordis 的 Context
   * 不适合被 Vue 的深层解包类型推导。
   */
  context?: unknown
}

/**
 * 通用设置页里的一个 section。
 *
 * @deprecated 用 `SettingsGroupRegistration` + `ctx.ui.registerSettingsGroup()`；
 * 旧接口等价于 pageId = 'settings.general'。
 */
export interface SettingsSection {
  id: string
  title?: string
  order?: number
  component: Component
  props?: Record<string, unknown>
}

export interface UiServiceApi {
  /** 注册导航项对应的页面组件；viewId 与清单里 contributes.nav[].id 一致 */
  registerView(viewId: string, component: Component): Disposable
  /** 向基础设置页追加一个分组；插件卸载时自动移除 */
  registerSettingsGroup(group: SettingsGroupRegistration): Disposable
  /** 某个设置页上由其它插件追加的分组；返回的数组是响应式的 */
  settingsGroups(pageId: string): SettingsGroupContribution[]
  /** @deprecated 用 registerSettingsGroup({ pageId: 'settings.general', ... }) */
  registerSettingsSection(section: SettingsSection): Disposable
  /** @deprecated 用 settingsGroups('settings.general') */
  settingsSections(): SettingsSection[]
  registerStatusBarItem(item: RendererStatusBarItem): Disposable
  componentOf(viewId: string): Component | undefined
  /** 切换到清单里已注册的导航页面；页面不存在（插件缺失或被禁用）时返回 false */
  navigate(viewId: string): boolean
}

export interface ThemeServiceApi {
  apply(themeId: string): void
  /** 渲染端：启动时从 localStorage 恢复主题 */
  restore(): void
  /** 渲染端：插件禁用后当前主题可能已不存在，回退到仍可用的主题 */
  reconcile(): void
  current(): string | undefined
  available(): { id: string; label: string }[]
}

export interface BridgeApi {
  invoke<T = unknown>(
    target: PluginId,
    method: string,
    params?: unknown,
    callerId?: PluginId
  ): Promise<T>
  on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): Disposable
  emit(topic: string, payload?: unknown, callerId?: PluginId): void
  readonly versions: Record<string, string>
  readonly platform: string
}

// ---------------------------------------------------------------------------
// 通过模块增强把服务挂到 cordis 的 Context 上
// ---------------------------------------------------------------------------

declare module 'cordis' {
  interface Context {
    plugins: PluginsServiceApi
    ipc: IpcServiceApi
    commands: CommandsServiceApi
    storage: StorageServiceApi
    permissions: PermissionsServiceApi
    /** 能力注册表：definition / provider / consumer 三角的注册与查找 */
    capabilities: CapabilitiesServiceApi
    /** 配置 schema 与当前值；设置页与 agent 共用 */
    configuration: ConfigurationServiceApi
    /** 主窗口生命周期（销毁 / 重建）；由内核包装宿主桥接提供 */
    mainWindow: MainWindowServiceApi
    ui: UiServiceApi
    theme: ThemeServiceApi
    bridge: BridgeApi
  }
}

export type { AppInfo, CommandInfo, PluginInfo, RuntimeEventEnvelope, RuntimeSnapshot }
