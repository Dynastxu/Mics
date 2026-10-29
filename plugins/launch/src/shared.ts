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

/** 主进程广播运行状态的事件主题 */
export const LAUNCH_STATE_TOPIC = 'mics.launch/state'
