import type { AppInfo } from './runtime'
import type { PluginId, PluginManifest } from './manifest'
import type { PluginSource } from './plugins'
import type { MainWindowHostApi } from './window'

/** 内核 id；bootstrap 依据 boot.config.json 找到它 */
export const KERNEL_ID = 'mics.kernel'

/** 自定义协议：渲染进程通过它加载插件产物 */
export const PLUGIN_SCHEME = 'mics-plugin'

/** 扫描插件目录后得到的记录（清单 + 解析后的入口绝对路径） */
export interface PluginRecord {
  dir: string
  manifest: PluginManifest
  /** 由扫描根目录决定，不由清单声明 */
  source: PluginSource
  entryMain?: string
  entryRenderer?: string
  /** 卸载脚本入口；未声明时为 undefined */
  entryUninstall?: string
  entryStyles: string[]
  warnings: string[]
}

export interface ScanError {
  dir: string
  errors: string[]
}

export interface ScanResult {
  plugins: PluginRecord[]
  errors: ScanError[]
}

/**
 * 宿主侧需要跟随插件集合变化的资源。
 *
 * 内核只负责告诉宿主「现在有哪些插件、各自在哪个目录」，具体怎么登记
 * （目前是 `mics-plugin://` 的 id → 目录映射）由宿主实现。
 */
export interface PluginHostBridge {
  syncPluginDirs(dirs: Record<PluginId, string>): void
  /**
   * 主窗口生命周期；缺省表示宿主不支持「销毁 / 重建主窗口」。
   *
   * 低内存托盘模式依赖它：窗口由 bootstrap 创建，插件只能通过这个桥接销毁
   * 主窗口并在恢复时重建，同时由宿主协调 `window-all-closed`。
   */
  mainWindow?: MainWindowHostApi
}

/**
 * 部署 profile：一组「启用集合 + 设置默认值」。
 *
 * 来自 `boot.config.json` 的 `profile` 与 `userData/profiles/<name>.json`。
 * - `enable` / `disable` 强制覆盖用户开关（`disable` 优先）；
 * - `settings` 是设置默认值，用户在设置页保存过的值优先。
 */
export interface ProfileConfig {
  name: string
  enable: PluginId[]
  disable: PluginId[]
  settings: Record<PluginId, Record<string, unknown>>
}

/**
 * 沙箱总开关。
 *
 * 它只回答一个问题：**要不要真的把插件放进子进程**。
 * 放进去之后限制到什么程度，由插件自己的 `trust` 决定：
 *
 * - `full`     —— 仍在主进程内（这类插件就是要高权限）；
 * - `isolated` —— 子进程，不加 `--permission`；
 * - `sandboxed`—— 子进程 + `--permission`，清单里的 fs / exec 声明生效。
 *
 * `off` 是回退开关：所有插件回到主进程，行为与改造前一致，权限只用于展示。
 */
export type SandboxMode = 'off' | 'on'

/** bootstrap 传给内核插件的配置 */
export interface KernelConfig {
  app: AppInfo
  /** 内核自身 id，默认 mics.kernel */
  kernel: string
  /** 沙箱模式；缺省 off */
  sandbox?: SandboxMode
  /** 首次扫描结果（bootstrap 为了找到内核已经扫过一遍） */
  plugins: PluginRecord[]
  /** 内置插件根目录，只读 */
  pluginRoots: string[]
  /** 第三方插件根目录，可写；安装 / 卸载都发生在这里 */
  userPluginRoot: string
  userDataDir: string
  disabled: string[]
  /** 当前 profile；未配置时为 undefined */
  profile?: ProfileConfig
  /** 首次扫描中失败的目录（清单非法、入口冲突等）；rescan 时会刷新 */
  scanErrors?: ScanError[]
  /**
   * 插件树的持久化文件（`cordis.yml`）。
   *
   * 只保存部署状态（主要是 `disabled`）；条目的增删由扫描结果决定，
   * 启动代码自己创建 entry，因此不需要 Include 参与挂载。
   */
  treeFile?: string
  /** 宿主资源同步接口；缺省表示不跟随变化（例如测试环境） */
  host?: PluginHostBridge
}

/** 内核插件模块的约定：普通 cordis 插件对象即可 */
export interface KernelModule {
  name?: string
  apply(ctx: import('cordis').Context, config: KernelConfig): unknown
}
