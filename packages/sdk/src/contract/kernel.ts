import type { AppInfo } from './runtime'
import type { PluginId, PluginManifest } from './manifest'
import type { PluginSource } from './plugins'

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
}

/** bootstrap 传给内核插件的配置 */
export interface KernelConfig {
  app: AppInfo
  /** 内核自身 id，默认 mics.kernel */
  kernel: string
  /** 首次扫描结果（bootstrap 为了找到内核已经扫过一遍） */
  plugins: PluginRecord[]
  /** 内置插件根目录，只读 */
  pluginRoots: string[]
  /** 第三方插件根目录，可写；安装 / 卸载都发生在这里 */
  userPluginRoot: string
  userDataDir: string
  disabled: string[]
  /** 宿主资源同步接口；缺省表示不跟随变化（例如测试环境） */
  host?: PluginHostBridge
}

/** 内核插件模块的约定：普通 cordis 插件对象即可 */
export interface KernelModule {
  name?: string
  apply(ctx: import('cordis').Context, config: KernelConfig): unknown
}
