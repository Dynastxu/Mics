/**
 * 插件清单（plugin.json）的声明式约定。
 * 清单在插件代码被加载之前就已可用，因此 UI、命令、主题等贡献点
 * 都能在插件尚未激活时展示出来（懒激活的前提）。
 */

export type PluginId = string

/** 激活事件：* / onStartup 随内核启动；onView:xxx、onCommand:xxx 由内核按需触发 */
export type ActivationEvent = '*' | 'onStartup' | `onView:${string}` | `onCommand:${string}`

export type Permission = 'shell:openExternal' | 'dialog:open' | 'clipboard:write' | 'notifications:show'

export type ViewRegion = 'sidebar' | 'main' | 'panel'

export interface ViewContribution {
  id: string
  title: string
  region?: ViewRegion
  /** 简单图标，M0 阶段使用 emoji 或单个字符 */
  icon?: string
  order?: number
  group?: string
}

export interface CommandContribution {
  id: string
  title: string
  category?: string
  /** 形如 ctrl+shift+p / ctrl+alt+h */
  keybinding?: string
  icon?: string
}

export interface StatusBarContribution {
  id: string
  text: string
  alignment?: 'left' | 'right'
  order?: number
  tooltip?: string
  command?: string
}

export interface ThemeContribution {
  id: string
  label: string
  type?: 'dark' | 'light'
  /** CSS 变量名 -> 值，例如 { "--mics-bg": "#0f1115" } */
  variables: Record<string, string>
}

export interface LayoutContribution {
  id: string
  label?: string
  regions?: {
    sidebar?: { width?: number; defaultView?: string }
  }
}

export interface PluginContributions {
  commands?: CommandContribution[]
  views?: ViewContribution[]
  statusBar?: StatusBarContribution[]
  themes?: ThemeContribution[]
  layout?: LayoutContribution
}

export interface PluginManifest {
  id: PluginId
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  keywords?: string[]
  /** 主进程入口，相对插件目录的 ESM 文件 */
  main?: string
  /** 渲染进程入口，相对插件目录的 ESM 文件 */
  renderer?: string
  /** 渲染进程样式，相对插件目录 */
  styles?: string[]
  /** 激活事件；缺省表示完全按需激活 */
  activation?: ActivationEvent[]
  /** 依赖的插件 id，内核保证先激活依赖 */
  dependencies?: PluginId[]
  /** 能力声明，供内核及其宿主服务校验 */
  permissions?: Permission[]
  contributes?: PluginContributions
  /** 内核级插件：不可通过界面禁用 */
  core?: boolean
}
