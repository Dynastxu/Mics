import type { PluginId } from './manifest'
import type { Disposable } from './services'

/**
 * 能力（capability）契约。
 *
 * 一个能力分三层，缺一层都不算完整：
 *   - definition：本文件里的常量 + 接口，只描述「叫什么、调用形状」；
 *   - provider：真正实现它的插件，可以有多份（本地 / 沙箱 / 远程），带优先级；
 *   - consumer：通过 `ctx.capabilities.require()` 使用能力的插件。
 *
 * 这样「能力名」是跨插件的稳定契约，而实现可以被替换：调用方不需要知道自己
 * 拿到的是本地进程还是沙箱进程。
 */

/** 在宿主上启动进程（启动游戏、执行校验程序等） */
export const SHELL_EXECUTE = 'mics.shell.execute'

/** 单文件传输（下载、校验、续传） */
export const FILE_TRANSFER = 'mics.net.file-transfer'

export type CapabilityName = string

export interface CapabilityProviderInfo {
  name: CapabilityName
  /** 实现的可读标签：local / sandbox / mirror … */
  label: string
  /** 数值越大越优先；同优先级时后注册的胜出 */
  priority: number
  /** 提供方插件 id（由注册时所在的上下文推断） */
  pluginId?: PluginId
}

export interface ProvideCapabilityOptions {
  label?: string
  priority?: number
}

// ---------------------------------------------------------------------------
// shell.execute：在宿主上启动一个进程
// ---------------------------------------------------------------------------

export interface ShellExecSpec {
  command: string
  args: string[]
  cwd?: string
  /** stdout/stderr 追加写入的日志文件；省略表示丢弃输出 */
  logFile?: string
  /** 进程独立于宿主存活：关闭应用不结束它 */
  detached?: boolean
  /** 进程环境变量；省略时继承宿主环境 */
  env?: Record<string, string | undefined>
}

export interface ShellProcess {
  readonly pid: number | undefined
  kill(signal?: string): void
  /** 解除与宿主的绑定，应用退出时不再等待它 */
  detach(): void
  /** 订阅进程事件；返回取消订阅函数 */
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): Disposable
}

export interface ShellExecuteCapability {
  readonly label: string
  /** 启动进程；resolve 表示进程已创建（收到 spawn），reject 表示创建失败 */
  spawn(spec: ShellExecSpec): Promise<ShellProcess>
}

// ---------------------------------------------------------------------------
// file-transfer：把单个文件下载到 .part 并做摘要
// ---------------------------------------------------------------------------

export interface TransferProgress {
  loaded: number
  total: number
}

export type TransferStatus = 'done' | 'paused' | 'failed'

export interface TransferOutcome {
  status: TransferStatus
  /** 下载内容的 SHA1（未要求校验时为空） */
  digest?: string
  error?: Error
}

export interface FileTransferSpec {
  url: string
  partPath: string
  sha1: string
  /** 期望的文件总大小；0 表示未知（未知大小时不做续传，直接重下） */
  size: number
  /**
   * 传输层要用的 HTTP(S) agent。
   *
   * 具体类型属于实现细节（本地实现要 node:http 的 Agent，沙箱实现可能需要别的东西），
   * 所以契约里只声明「透传」，由 provider 自己解释。
   */
  agents?: unknown
  /**
   * 附加请求头。
   *
   * 部分镜像（例如 BMCLAPI 重定向到的 CERNET 节点）会拒绝没有 User-Agent
   * 的请求并返回 403，所以调用方必须把品牌头透传下来。
   */
  headers?: Record<string, string>
  /**
   * 单文件最多使用多少条并行 Range 连接；1 或省略表示单连接。
   *
   * 只有文件大小已知且服务端支持 `Accept-Ranges: bytes` 时实现才会启用，
   * 不支持时实现必须自动退回单连接。
   */
  segments?: number
  onProgress?: (progress: TransferProgress) => void
  /** 服务端忽略 Range、从头下载时通知调用方重置进度 */
  onRestart?: () => void
}

export interface FileTransferHandle {
  /** 开始（或续传）下载；暂停/取消后也会 resolve，由 status 区分 */
  start(): Promise<TransferOutcome>
  /** 中止当前请求，保留 .part；可重复调用 */
  stop(): Promise<void>
}

export interface FileTransferCapability {
  readonly label: string
  create(spec: FileTransferSpec): FileTransferHandle
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export interface CapabilitiesServiceApi {
  /**
   * 发布一份实现。注册绑定在调用方插件上：插件卸载时实现自动撤销，
   * 使用方会收到 `capability/changed`。
   */
  provide<T>(name: CapabilityName, impl: T, options?: ProvideCapabilityOptions): Disposable
  /** 当前优先级最高的实现；没有提供方时返回 undefined */
  get<T>(name: CapabilityName): T | undefined
  /** 同 get，但没有提供方时抛错（错误信息里列出已注册的能力名） */
  require<T>(name: CapabilityName): T
  /** 某个能力的全部提供方，按优先级排序（诊断用） */
  providers(name: CapabilityName): CapabilityProviderInfo[]
  /** 已注册的能力名 */
  names(): CapabilityName[]
  /** 某个能力当前被哪些插件使用过（诊断用；按 `require()` 的调用方登记） */
  consumers(name: CapabilityName): PluginId[]
  /** 某个插件使用过哪些能力（诊断用） */
  consumersOf(pluginId: PluginId): CapabilityName[]
  /** 实现出现 / 消失 / 被更高优先级顶替时回调当前实现 */
  onChange(name: CapabilityName, listener: (impl: unknown) => void): Disposable
}
