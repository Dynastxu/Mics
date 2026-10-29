/**
 * 插件清单（plugin.json）的声明式约定。
 * 清单在插件代码被加载之前就已可用，因此 UI、命令、主题等贡献点
 * 都能在插件尚未激活时展示出来（懒激活的前提）。
 */

export type PluginId = string

/** 激活事件：* / onStartup 随内核启动；onView:xxx、onCommand:xxx 由内核按需触发 */
export type ActivationEvent = '*' | 'onStartup' | `onView:${string}` | `onCommand:${string}`

export type Permission = 'shell:openExternal' | 'dialog:open' | 'clipboard:write' | 'notifications:show'

/**
 * 左侧导航里的一个页面。
 *
 * `id` 同时是渲染器里 `ctx.ui.registerView(id, component)` 的注册键：
 * 清单先声明入口，组件按需加载。
 */
export interface NavContribution {
  id: string
  title: string
  /** 图标名（见 shell 的图标表）或单个字符 */
  icon?: string
  order?: number
  /** 所属分组 id；缺省表示顶层导航项（例如「启动」） */
  group?: string
}

/** 导航分组：只提供标题与图标，子项由各插件用 `nav` + `group` 自行挂载 */
export interface NavGroupContribution {
  id: string
  title: string
  icon?: string
  order?: number
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
    nav?: { width?: number; defaultView?: string }
  }
}

export interface PluginContributions {
  /** 左侧导航项（顶层或分组的子项），每个 id 对应一个页面 */
  nav?: NavContribution[]
  navGroups?: NavGroupContribution[]
  commands?: CommandContribution[]
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
  /**
   * 卸载脚本，相对插件目录的 ESM 文件，默认导出一个函数。
   *
   * 在插件停止之后、宿主删除插件目录之前执行，用来清理插件自己在插件目录之外
   * 创建的东西（下载的文件、游戏实例等）。只有带 `main` 的插件可以声明——
   * 页面插件没有主进程，也就没有执行清理逻辑的权限。
   */
  uninstall?: string
  /** 激活事件；缺省表示完全按需激活 */
  activation?: ActivationEvent[]
  /** 依赖的插件 id，内核保证先激活依赖 */
  dependencies?: PluginId[]
  /** 能力声明，供内核及其宿主服务校验 */
  permissions?: Permission[]
  contributes?: PluginContributions
  /** 内核级插件：不可通过界面禁用 */
  core?: boolean
  /**
   * 必需插件：同样不可禁用。
   *
   * 与 core 的区别是语义：essential 用于「缺少它就无法从界面恢复自身」的插件，
   * 例如插件管理页本身；core 用于内核级插件。
   */
  essential?: boolean
}
