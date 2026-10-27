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

export interface LaunchResult {
  pid: number
}
