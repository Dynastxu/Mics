import type { PluginId, PluginManifest } from './manifest'
import type { PluginFailure, PluginSource, PluginStatus, ProfileLock } from './plugins'

export type PluginState =
  | 'discovered'
  | 'activating'
  | 'active'
  | 'waiting'
  | 'failed'
  | 'stopped'
  | 'disabled'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  isDev: boolean
  userDataPath?: string
  /** 当前部署 profile 名；未启用 profile 时为 undefined */
  profile?: string
}

export interface PluginInfo {
  id: PluginId
  name: string
  version: string
  description?: string
  author?: string
  state: PluginState
  /** 界面状态：已启用 / 已禁用 / 失败（未安装的插件不在列表里） */
  status: PluginStatus
  /** 内置 / 第三方 */
  source: PluginSource
  core: boolean
  /** 必需插件：不可禁用（例如插件管理页自身） */
  essential: boolean
  /** 是否允许切换开关：core / essential 与 profile 锁住的插件为 false */
  canDisable: boolean
  /**
   * profile 把开关锁在哪个方向。
   *
   * `enabled` 表示 profile 强制启用（用户不能禁用）；`disabled` 表示强制禁用。
   * 界面需要据此禁用开关并说明原因。
   */
  profileLocked?: ProfileLock
  /** 是否可以卸载：只有第三方插件可以 */
  uninstallable: boolean
  /** 是否声明了卸载脚本 */
  hasUninstall: boolean
  /** 完整清单，渲染端据此生成导航、命令、主题等 */
  manifest: PluginManifest
  hasMain: boolean
  hasRenderer: boolean
  /** 形如 mics-plugin://mics.download.mod/dist/renderer.mjs */
  rendererUrl?: string
  /** 形如 mics-plugin://mics.download.mod/dist/style.css */
  styles: string[]
  /**
   * 正在等待的服务名（`inject` 里还没人提供的那些）。
   *
   * 只在 `state === 'waiting'` 时有值：插件已经挂载，但代码没有执行，
   * 直到这些服务出现。与 `status: 'failed'` 的区别是它不需要修代码。
   */
  waitingFor?: string[]
  /**
   * 清单依赖（`dependencies`）的问题：缺插件、依赖自己、循环依赖。
   *
   * 这类问题在激活前就能确定，属于「装错了」而不是「跑挂了」。
   */
  dependencyIssues?: string[]
  /**
   * 失败的阶段与完整诊断；与 `error` 同时存在。
   *
   * `error` 是给人看的一行消息，`failure.stage` 决定界面该给什么恢复动作。
   */
  failure?: PluginFailure
  /**
   * 上一次停止超时：旧代码可能仍在运行。
   *
   * 为 true 时内核拒绝再次激活该插件（否则会出现两个 fiber），
   * 需要重启应用才能清除。
   */
  restartRequired?: boolean
  error?: string
}

export interface CommandInfo {
  id: string
  title: string
  category?: string
  keybinding?: string
  pluginId?: PluginId
}

export interface RuntimeSnapshot {
  app: AppInfo
  plugins: PluginInfo[]
  commands: CommandInfo[]
}

export interface RpcRequest {
  target: PluginId
  method: string
  params?: unknown
  /** 调用方插件 id（渲染端尽力而为，见 docs/architecture.md 信任模型） */
  callerId?: PluginId
}

export type RpcResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { message: string; stack?: string } }

export interface RuntimeEventEnvelope {
  topic: string
  source?: PluginId
  payload?: unknown
  ts: number
}
