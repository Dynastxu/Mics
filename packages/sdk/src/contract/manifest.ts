/**
 * 插件清单（plugin.json）的声明式约定。
 * 清单在插件代码被加载之前就已可用，因此 UI、命令、主题等贡献点
 * 都能在插件尚未激活时展示出来（懒激活的前提）。
 */

import type { ConfigurationContribution } from './configuration'

export type PluginId = string

/** 激活事件：* / onStartup 随内核启动；onView:xxx、onCommand:xxx 由内核按需触发 */
export type ActivationEvent = '*' | 'onStartup' | `onView:${string}` | `onCommand:${string}`

/**
 * v1 能力字符串。
 *
 * v2 用 `os.*` 重新表达；这里保留是为了让已有清单和 `ctx.permissions.has()`
 * 的调用点继续工作。新插件应当直接写 v2 对象。
 */
export type LegacyPermission =
  | 'shell:openExternal'
  | 'dialog:open'
  | 'clipboard:write'
  | 'notifications:show'

/** @deprecated 使用 `LegacyPermission`；旧名字保留以免破坏既有 import */
export type Permission = LegacyPermission

/**
 * 信任级别，决定插件**能做什么**。
 *
 * - `full`：主进程内，与 MICS 本身同权限（需要扫系统目录、起子进程、开托盘的那类）；
 * - `sandboxed`：独立子进程 + Node `--permission`，文件与子进程由引擎强制。
 *
 * 「跑在哪个进程」不在这里表达：`sandbox` 总开关决定要不要把非 full 的插件
 * 放进子进程。一个 `full` 插件即使开了沙箱也仍然留在主进程——它就是要高权限。
 */
export type TrustLevel = 'full' | 'sandboxed'

/**
 * 文件访问白名单。
 *
 * 只支持目录（以及可选的末尾 `/**`），**不支持段内通配**——引擎侧的
 * `--allow-fs-*` 只认路径前缀，写 `*.jar` 只会让人误以为被限制了。
 */
export interface FsPermissions {
  /** 只读目录 */
  read?: string[]
  /** 可写目录（同时含读取能力） */
  write?: string[]
  /** 只需要 stat / readdir 的目录 */
  meta?: string[]
}

/** 允许执行的程序；`args` 是按位置匹配的正则 */
export interface ExecPermission {
  bin: string
  args?: string[]
}

export type NetMode = 'none' | 'allowlist' | 'all'

export interface NetPermissions {
  mode: NetMode
  /** `allowlist` 时必填；`*.example.com` 匹配 apex 与任意层级子域 */
  hosts?: string[]
  /** 缺省 [443] */
  ports?: number[]
  allowPlainHttp?: boolean
  allowPrivate?: boolean
}

export type ClipboardAccess = 'none' | 'write' | 'read'
export type DialogAccess = 'none' | 'open' | 'save'

/** 走宿主代做的系统能力 */
export interface OsPermissions {
  openExternal?: boolean
  notifications?: boolean
  clipboard?: ClipboardAccess
  dialogs?: DialogAccess
}

/**
 * 归一化之后的权限声明。
 *
 * 清单里可以写 v1 数组或 v2 对象，扫描阶段统一转换成本结构；
 * 之后的判定、展示、启动参数都只认这一份。
 */
export interface PluginPermissions {
  trust: TrustLevel
  fs?: FsPermissions
  exec?: ExecPermission[]
  net?: NetPermissions
  os?: OsPermissions
}

/** 清单里 `permissions` 接受的两种写法 */
export type PermissionDeclaration = LegacyPermission[] | PluginPermissions

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
  /** 右侧自定义区域插槽名，对应 ctx.ui.registerView 注册的组件 */
  rightSlot?: string
  /** 右侧区域显示策略：'always' 常驻 | 'hover' 鼠标悬停时显示，默认 'hover' */
  rightDisplay?: 'always' | 'hover'
}

/** 导航分组：只提供标题与图标，子项由各插件用 `nav` + `group` 自行挂载 */
export interface NavGroupContribution {
  id: string
  title: string
  icon?: string
  order?: number
  /** 右侧自定义区域插槽名，对应 ctx.ui.registerView 注册的组件 */
  rightSlot?: string
  /** 右侧区域显示策略：'always' 常驻 | 'hover' 鼠标悬停时显示，默认 'hover' */
  rightDisplay?: 'always' | 'hover'
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
  /**
   * 设置项 schema。
   *
   * 声明后：`ctx.storage.get/set` 自动补默认值并校验；设置页可以自动渲染；
   * agent 可以通过 `configuration/*` RPC 结构化读写。复杂结构仍由插件自己的
   * 设置页处理，但同样经过 storage 的校验。
   */
  configuration?: ConfigurationContribution
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
  /**
   * 权限声明。
   *
   * 两种写法都接受：v1 的字符串数组（映射成 `trust: 'full'`），
   * 或 v2 的结构化对象。扫描阶段归一化，运行时只认 `PluginPermissions`。
   */
  permissions?: PluginPermissions
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
  /**
   * 实验性插件：插件管理页标注，便于用户识别功能尚未稳定。
   *
   * 只影响展示；是否默认关闭由 `defaultDisabled` 单独决定。
   */
  experimental?: boolean
  /**
   * 默认关闭：首次出现时禁用，用户显式启用后写入 `enabled-plugins.json`。
   *
   * 与 `core` / `essential` 冲突时以后者为准——必需插件不能默认关闭。
   */
  defaultDisabled?: boolean
}
