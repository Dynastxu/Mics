import type { PluginId } from './manifest'

/**
 * 插件来源。
 *
 * - `builtin`：随安装包分发，位于应用目录，只读；
 * - `user`：用户后来安装，位于用户数据目录，可写。
 *
 * 来源由宿主扫描的根目录决定，不由清单声明——写进 plugin.json 等于让插件自己
 * 声明自己免于卸载。
 */
export type PluginSource = 'builtin' | 'user'

/**
 * 插件在界面上呈现的三种状态。
 *
 * 与 `PluginState` 的区别：`PluginState` 还包含 discovered / activating / stopped
 * 这些瞬时状态，`PluginStatus` 只描述用户能看到的稳定结果。
 */
export type PluginStatus = 'enabled' | 'disabled' | 'failed'

/** 安装前给用户看的摘要（不落盘，只用于确认框） */
export interface PluginInstallSummary {
  id: PluginId
  name: string
  version: string
  author?: string
  description?: string
  /** 带主进程入口：安装后拥有完整 Node 权限 */
  hasMain: boolean
  hasRenderer: boolean
  /** 声明了卸载脚本 */
  hasUninstall: boolean
  /** 同 id 已安装时的旧版本号（升级场景） */
  installedVersion?: string
  warnings: string[]
}

export type PluginInstallOutcome =
  | { status: 'installed'; plugin: PluginInstallSummary; upgraded: boolean }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

export type PluginUninstallOutcome =
  | { status: 'uninstalled'; id: PluginId }
  | { status: 'cancelled' }
  | {
      status: 'failed'
      id: PluginId
      message: string
      /** 失败发生在卸载脚本（可以强制卸载跳过清理）；文件删除失败时为 false */
      retryable: boolean
    }

/**
 * 卸载失败时抛出的错误，让调用方区分「脚本失败」和「删文件失败」。
 *
 * - `script`：卸载脚本抛错或超时，插件本体仍在，可重试或强制卸载；
 * - `files`：脚本已执行，但删除目录失败，需要用户处理后重试。
 */
export class PluginUninstallError extends Error {
  readonly stage: 'script' | 'files'

  constructor(message: string, stage: 'script' | 'files') {
    super(message)
    this.name = 'PluginUninstallError'
    this.stage = stage
  }
}
