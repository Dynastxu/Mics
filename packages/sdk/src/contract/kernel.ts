import type { AppInfo } from './runtime'
import type { PluginManifest } from './manifest'

/** 内核 id；bootstrap 依据 boot.config.json 找到它 */
export const KERNEL_ID = 'mics.kernel'

/** 自定义协议：渲染进程通过它加载插件产物 */
export const PLUGIN_SCHEME = 'mics-plugin'

/** 扫描插件目录后得到的记录（清单 + 解析后的入口绝对路径） */
export interface PluginRecord {
  dir: string
  manifest: PluginManifest
  entryMain?: string
  entryRenderer?: string
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

/** bootstrap 传给内核插件的配置 */
export interface KernelConfig {
  app: AppInfo
  /** 内核自身 id，默认 mics.kernel */
  kernel: string
  plugins: PluginRecord[]
  pluginRoots: string[]
  userDataDir: string
  disabled: string[]
}

/** 内核插件模块的约定：普通 cordis 插件对象即可 */
export interface KernelModule {
  name?: string
  apply(ctx: import('cordis').Context, config: KernelConfig): unknown
}
