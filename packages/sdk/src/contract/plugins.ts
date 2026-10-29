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
 * 插件在界面上呈现的状态。
 *
 * 与 `PluginState` 的区别：`PluginState` 还包含 discovered / activating / stopped
 * 这些瞬时状态，`PluginStatus` 只描述用户能看到的稳定结果。
 *
 * `waiting` 表示插件已经挂载，但它 `inject` 的服务还没人提供——代码没跑起来，
 * 不能算 enabled；文件与开关都正常，也不能算 failed。见 `PluginInfo.waitingFor`。
 */
export type PluginStatus = 'enabled' | 'waiting' | 'disabled' | 'failed'

/** profile 对插件开关的强制方向 */
export type ProfileLock = 'enabled' | 'disabled'

/**
 * cordis `Fiber.state` 的数值。
 *
 * cordis 把它声明成 `const enum`，跨包引用在 `isolatedModules` 下不可用，
 * 这里复制一份最小常量表：只用来判断「插件是否真的跑起来了」。
 */
export const FIBER_PENDING = 0
export const FIBER_LOADING = 1
export const FIBER_ACTIVE = 2
export const FIBER_FAILED = 3
export const FIBER_DISPOSED = 4
export const FIBER_UNLOADING = 5

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

/**
 * 插件失败发生在哪一步。
 *
 * 分开表达不是为了分类，而是因为可恢复动作不同：
 *   - `manifest`   清单非法 —— 改清单 / 重装；
 *   - `import`     入口模块导入失败 —— 修产物 / 重装；
 *   - `apply`      cordis 插件启动时抛错 —— 修代码后重载；
 *   - `dependency` 清单依赖或服务依赖没满足 —— 启用/安装依赖；
 *   - `timeout`    停止超时，旧代码可能还在跑 —— 重启应用或强制处理；
 *   - `renderer`   渲染端加载失败（页面产物） —— 修产物后重载；
 *   - `policy`     被策略插件拒绝激活 —— 调整策略或换插件。
 */
export type PluginFailureStage =
  | 'manifest'
  | 'import'
  | 'apply'
  | 'dependency'
  | 'timeout'
  | 'renderer'
  | 'policy'

/** 一次失败的完整诊断；`PluginInfo.error` 保留为它的短消息。 */
export interface PluginFailure {
  stage: PluginFailureStage
  message: string
  /** 失败发生时间（Unix ms） */
  at: number
}

/**
 * 带阶段的插件错误。
 *
 * 内核在 import / apply / 依赖 / 停止超时等位置抛出它，渲染端在页面加载失败时
 * 也用它标注阶段；`PluginsService` 只认这个类型，其它异常按调用点的默认阶段归类。
 */
export class PluginFailureError extends Error {
  readonly stage: PluginFailureStage

  constructor(stage: PluginFailureStage, message: string) {
    super(message)
    this.name = 'PluginFailureError'
    this.stage = stage
  }
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
