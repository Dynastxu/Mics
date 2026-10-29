/** 启动页展示的实例摘要；主进程与渲染器共用同一份结构 */
export interface InstanceSummary {
  id: string
  name: string
  minecraft: string
  loader: string
  mods: number
  /** 上次启动时间戳；从未启动为 null */
  lastPlayed: number | null
  versionId: string
}

export interface LaunchRequest {
  id: string
  username: string
}

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
  /** 实例根目录绝对路径 */
  dir: string
  /** 当前生效的版本目录绝对路径 */
  versionDir: string
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

/** 主进程广播运行状态的事件主题 */
export const LAUNCH_STATE_TOPIC = 'mics.launch/state'
