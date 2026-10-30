/**
 * 实例摘要已上移到 `@mics/sdk`：Mod 安装的实例选择器也消费同一份结构。
 * 这里继续导出，启动页内部原有的 `./shared` 导入不需要改。
 */
export type { InstanceSummary } from '@mics/sdk'
import type { ModIdentity } from '@mics/sdk'

export interface LaunchRequest {
  id: string
  /** 使用哪个账户启动；省略时由账户插件使用当前选中的账户 */
  accountId?: string
}

/** 启动前发现缺失 / 损坏的必要文件 */
export interface MissingFile {
  /** 展示名，例如 `org.ow2.asm:asm-tree:9.10.1` */
  label: string
  /** 相对版本目录的路径；版本目录之外的文件给绝对路径 */
  path: string
}

/**
 * `instances/launch` 的结果。
 *
 * 文件不完整不是异常，而是需要用户确认补全的可预期结果：主进程把清单
 * 原样返回，界面据此弹窗，确认后交给下载管线的补全任务。
 */
export type LaunchOutcome =
  | { status: 'launched'; pid: number }
  | { status: 'missing-files'; files: MissingFile[] }

/** 一次启动所处的阶段：等待游戏窗口出现 / 已在运行 */
export type LaunchPhase = 'starting' | 'running'

export interface LaunchProcessInfo {
  pid: number
  startedAt: number
  phase: LaunchPhase
}

export interface InstanceLaunchState {
  id: string
  processes: LaunchProcessInfo[]
}

/**
 * 主进程持有的运行状态快照。
 * 渲染端挂载时拉一次，之后通过 `mics.launch/state` 事件保持同步。
 */
export interface LaunchState {
  instances: InstanceLaunchState[]
}

/** 实例已在运行时的行为：弹窗询问 / 直接启动 / 忽略点击 */
export type RepeatLaunchBehavior = 'prompt' | 'launch' | 'ignore'

export interface LaunchSettings {
  repeatBehavior: RepeatLaunchBehavior
  /** 游戏 JVM 最大堆内存（MB） */
  maxMemory: number
}

export interface TerminateRequest {
  id: string
}

export interface TerminateResult {
  terminated: number
}

/** 实例内的可打开位置 */
export type InstanceArea = 'root' | 'logs' | 'mods'

/** 实例详情页的静态信息；占用大小由单独的 RPC 统计 */
export interface InstanceDetail {
  id: string
  name: string
  /** 实例根目录绝对路径（同时是游戏目录与版本目录） */
  dir: string
  versionId: string
  minecraft: string
  loader: string
  versionType: string | null
  javaMajor: number | null
  mods: number
}

/** 占用大小中的一项：实例根目录下的顶层目录，散落文件归入 `.` */
export interface InstanceUsageEntry {
  name: string
  size: number
  files: number
}

export interface InstanceUsage {
  total: number
  files: number
  entries: InstanceUsageEntry[]
  computedAt: number
}

export interface InstanceLogFile {
  name: string
  size: number
  modified: number
}

export interface InstanceLogContent extends InstanceLogFile {
  content: string
  /** 只返回了文件末尾的一部分 */
  truncated: boolean
}

export interface InstanceModEntry {
  fileName: string
  /** 去掉 .jar / .jar.disabled 后缀的展示名 */
  name: string
  size: number
  modified: number
  enabled: boolean
  /** jar 内嵌图标（data URL）；没有时为空 */
  icon?: string
  /** 元数据里的 mod id / 名称，用于跳转到 Mod 目录详情 */
  modId?: string
  modName?: string
  /** Modrinth 指纹 */
  sha1?: string
  /** CurseForge 指纹 */
  murmur2?: number
  /** 指纹识别到的精确项目（异步补全；识别失败时为空） */
  identity?: ModIdentity
}

export interface InstanceMods {
  dir: string
  entries: InstanceModEntry[]
}

export interface InstanceRef {
  id: string
}

export interface InstanceLogRequest extends InstanceRef {
  name: string
}

export interface InstanceRevealRequest extends InstanceRef {
  area?: InstanceArea
}

export interface InstanceModToggleRequest extends InstanceRef {
  fileName: string
  enabled: boolean
}

export interface InstanceModDeleteRequest extends InstanceRef {
  fileName: string
}

/** 主进程广播运行状态的事件主题 */
export const LAUNCH_STATE_TOPIC = 'mics.launch/state'
