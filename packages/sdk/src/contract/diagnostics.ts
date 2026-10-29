import type { PluginFailure, PluginSource, PluginStatus } from './plugins'
import type { ScanError } from './kernel'
import type { PluginId } from './manifest'
import type { PluginState } from './runtime'

/** 一条依赖是怎么建立的：清单声明、注入服务、还是使用能力 */
export type PluginDependencyKind = 'manifest' | 'service' | 'capability'

export interface PluginDependencyDetail {
  kind: PluginDependencyKind
  /** 服务名 / 能力名；`manifest` 依赖没有 */
  via?: string
  /** 这一条依赖当前是否满足 */
  satisfied: boolean
}

/**
 * 「我依赖某个插件」或「某个插件依赖我」。
 *
 * 同一对插件可能同时存在多种依赖（清单 + 服务），所以按目标插件聚合，
 * `details` 里保留每种来源。这样界面一行能说清「为什么它是必需的」。
 */
export interface PluginDependencyRef {
  id: PluginId
  name: string
  /** 目标插件当前状态；目标未安装时为 undefined */
  status?: PluginStatus
  /** 所有来源都满足才为 true */
  satisfied: boolean
  details: PluginDependencyDetail[]
}

/** 我提供出去的运行时服务或能力 */
export interface PluginProvideRef {
  kind: 'service' | 'capability'
  name: string
  /** 能力提供方的可读标签（local / sandbox / mirror …） */
  label?: string
  /** 能力提供方优先级 */
  priority?: number
}

/** 我使用、但不一定形成插件依赖的服务或能力（内核服务也在这里） */
export interface PluginConsumeRef {
  kind: 'service' | 'capability'
  name: string
  providerId?: PluginId
  satisfied: boolean
}

export type PluginContributionKind =
  | 'rpc'
  | 'command'
  | 'view'
  | 'navGroup'
  | 'statusBar'
  | 'theme'
  | 'layout'
  | 'configuration'

/** 我注册的贡献点；`view` 对应清单里的 nav id */
export interface PluginContributionRef {
  kind: PluginContributionKind
  id: string
  title?: string
}

/** 依赖图里的一个插件节点 */
export interface PluginGraphNode {
  id: PluginId
  name: string
  version: string
  status: PluginStatus
  state: PluginState
  source: PluginSource
  failure?: PluginFailure
  /** 停止超时过，重启应用前不能再次激活 */
  restartRequired?: boolean
  /** 我依赖的插件（清单依赖 + 非内核服务 + 能力提供方） */
  dependsOn: PluginDependencyRef[]
  /** 依赖我的插件（与 `dependsOn` 互逆） */
  dependents: PluginDependencyRef[]
  /** 我提供的服务与能力 */
  provides: PluginProvideRef[]
  /** 我使用到的服务与能力（含内核服务） */
  consumes: PluginConsumeRef[]
  /** 我注册的 RPC / 命令 / 页面 / 主题 / 状态栏 */
  contributes: PluginContributionRef[]
  warnings: string[]
}

/** 全局视角下没有被满足的需求 */
export interface PluginUnmetRef {
  kind: 'plugin' | 'service' | 'capability'
  name: string
  /** 需要它、但当前拿不到的插件 */
  neededBy: PluginId[]
}

/**
 * 插件依赖图与贡献点报告。
 *
 * 这是「插件为什么没生效」的唯一只读事实来源：插件管理页和 agent 都通过
 * `plugins/diagnostics` RPC 读它，不各自拼一套推断。
 */
export interface PluginGraphReport {
  generatedAt: number
  kernel: PluginId
  /** 当前部署 profile 名；未启用时为 undefined */
  profile?: string
  nodes: PluginGraphNode[]
  unmet: PluginUnmetRef[]
  /** 扫描阶段就失败的目录（清单非法、入口缺失等） */
  scanIssues: ScanError[]
}
