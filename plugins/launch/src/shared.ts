/** 启动页展示的实例摘要；主进程与渲染器共用同一份结构 */
export interface InstanceSummary {
  id: string
  name: string
  minecraft: string
  loader: string
  mods: number
  lastPlayed: string
}
