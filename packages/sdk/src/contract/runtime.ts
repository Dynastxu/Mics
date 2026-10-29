import type { PluginId, PluginManifest } from './manifest'
import type { PluginSource, PluginStatus } from './plugins'

export type PluginState = 'discovered' | 'activating' | 'active' | 'failed' | 'stopped' | 'disabled'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  isDev: boolean
  userDataPath?: string
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
  /** 是否允许禁用：core 与 essential 锁住 */
  canDisable: boolean
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
