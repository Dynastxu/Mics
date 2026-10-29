import type { Context } from 'cordis'
import type { CapabilityProviderInfo } from './capability'
import type { PluginId } from './manifest'
import type { RpcRequest, RpcResponse } from './runtime'

/**
 * cordis 4 的五种事件派发模式。
 *
 * 选错模式不会报错，只会让语义变得靠猜，因此每个事件都在
 * `MicsEvents` 上写明模式，并由 `EVENT_MODES` 统一登记：
 *
 * | 模式 | 语义 | 适用 |
 * | --- | --- | --- |
 * | `emit` | 通知，同步执行，返回值丢弃 | 状态变化、观察点 |
 * | `parallel` | 扇出，等全部完成，失败聚合成 AggregateError | 互不依赖的收尾工作 |
 * | `serial` | 串行，遇到第一个结论即停止 | 需要异步判断的审批 |
 * | `bail` | 同步投票，第一个非空返回值即结论 | 同步决策（主题选择、同步审批） |
 * | `waterfall` | 中间件，监听器拿到 `next()`，可短路或改写 | 执行路径拦截（IPC、命令） |
 *
 * 派发方一律使用本文件导出的 `emitEvent` / `bailEvent` / `waterfallEvent`
 * 等辅助函数：事件名与模式对不上时是编译错误，而不是运行期才发现的约定问题。
 */
export type EventDispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

/**
 * 插件激活审批结论。
 *
 * 监听器返回 `undefined` 表示「不表态」；第一个返回结论的监听器生效。
 * 因此审批插件应当用 `ctx.on(name, fn, true)`（prepend）注册，
 * 让拒绝结论先于放行结论。
 */
export interface PluginActivationVerdict {
  allow: boolean
  /** 拒绝原因；会进入插件失败态与诊断信息 */
  reason?: string
}

/**
 * Mics 对 cordis 的事件扩展。
 *
 * 与 cordis 自带的 `internal/*` 事件分开维护，`EVENT_MODES` 只覆盖这里声明的事件；
 * 新增事件时表与接口一起改，漏写模式会直接编译失败。
 */
export interface MicsEvents {
  /** 通知：插件集合或任一插件状态变化。 */
  'plugins/changed'(): void

  /** 通知：插件真正进入 active（服务依赖满足、apply 执行完毕）。 */
  'plugin/activated'(id: PluginId): void

  /** 通知：插件被停用、卸载或失败。 */
  'plugin/deactivated'(id: PluginId): void

  /**
   * 审批：激活一个插件之前询问所有插件。
   *
   * 同步投票（`bail`）：返回 `{ allow: false, reason }` 即拒绝，返回
   * `undefined` 表示不表态。需要异步审批时请挂在 `ipc/before`。
   */
  'plugin/beforeActivate'(id: PluginId): PluginActivationVerdict | void

  /**
   * RPC 派发前的中间件链（`waterfall`）。
   *
   * 每个监听器拿到请求和 `next()`：返回 `next()` 继续、返回 `RpcResponse`
   * 短路。权限、审计、限流、二次确认都挂在这里，内核不再为每条策略加 if。
   */
  'ipc/before'(request: RpcRequest, next: () => Promise<RpcResponse>): Promise<RpcResponse>

  /** RPC 派发后的观察点（`emit`）；只做同步记录，异步工作请自行排队。 */
  'ipc/after'(request: RpcRequest, response: RpcResponse): void

  /** 通知：某能力的提供方发生变化（新增、撤销、被更高优先级顶替）。 */
  'capability/changed'(name: string, providers: CapabilityProviderInfo[]): void
}

/**
 * 每个 Mics 事件的派发模式。
 *
 * `satisfies Record<keyof MicsEvents, …>` 保证：新增事件却忘了登记模式时
 * 编译失败，读者也不需要翻派发点猜语义。
 */
export const EVENT_MODES = {
  'plugins/changed': 'emit',
  'plugin/activated': 'emit',
  'plugin/deactivated': 'emit',
  'plugin/beforeActivate': 'bail',
  'ipc/before': 'waterfall',
  'ipc/after': 'emit',
  'capability/changed': 'emit',
} as const satisfies Record<keyof MicsEvents, EventDispatchMode>

export type MicsEventName = keyof MicsEvents

/** 某个派发模式允许的事件名；用来把「事件名 + 模式」写进函数签名 */
export type EventInMode<M extends EventDispatchMode> = {
  [K in MicsEventName]: (typeof EVENT_MODES)[K] extends M ? K : never
}[MicsEventName]

type Args<K extends MicsEventName> = Parameters<MicsEvents[K]>

/** 通知（`emit`）：只表达「发生了什么」，没有返回值，也不会等待。 */
export function emitEvent<K extends EventInMode<'emit'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): void {
  ctx.emit(name, ...args)
}

/** 同步投票（`bail`）：第一个返回非空值的监听器给出结论。 */
export function bailEvent<K extends EventInMode<'bail'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): ReturnType<MicsEvents[K]> {
  return ctx.bail(name, ...args) as ReturnType<MicsEvents[K]>
}

/** 中间件（`waterfall`）：监听器通过 `next()` 决定是否继续。 */
export function waterfallEvent<K extends EventInMode<'waterfall'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): ReturnType<MicsEvents[K]> {
  return ctx.waterfall(name, ...args) as ReturnType<MicsEvents[K]>
}

/** 串行处理（`serial`）：逐个等待监听器，遇到第一个结论即停止。 */
export async function serialEvent<K extends EventInMode<'serial'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): Promise<Awaited<ReturnType<MicsEvents[K]>>> {
  return (await ctx.serial(name, ...args)) as Awaited<ReturnType<MicsEvents[K]>>
}

/** 扇出（`parallel`）：等全部监听器完成，不读取返回值。 */
export async function parallelEvent<K extends EventInMode<'parallel'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): Promise<void> {
  await ctx.parallel(name, ...args)
}

declare module 'cordis' {
  interface Events extends MicsEvents {}
}
