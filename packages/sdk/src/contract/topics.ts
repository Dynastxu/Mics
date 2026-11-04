import type { Context, Events } from 'cordis'
import type { RuntimeSnapshot } from './runtime'

/**
 * 跨进程 topic 契约。
 *
 * 与 Cordis 的进程内事件（`emit` / `waterfall` / `bail` / `serial` / `parallel`）
 * 是两层东西，不能混：
 *
 * - Cordis 事件：同步派发，参数里可以有函数与对象引用（`next()`、`ctx`），
 *   因此**物理上无法跨进程**；
 * - Runtime topic：只承载可序列化数据，没有返回值、没有 `next()`、不能拦截，
 *   由主进程经 `mics:event` 广播到每个窗口。
 *
 * 两者用**前缀**区分：topic 一律以 `ipc:` 开头。主进程广播时会在本地再派发一次
 * 同名 Cordis 事件，渲染端在边界处把收到的帧重新派发成本地 Cordis 事件——
 * 于是插件在两边都只写 `ctx.on('ipc:...')`，不需要知道事件从哪个进程来。
 *
 * 事件表只有一份：cordis 的 `Events`。新增 topic 时在**拥有它的插件里**增补：
 *
 * ```ts
 * declare module 'cordis' {
 *   interface Events {
 *     'ipc:my-plugin/changed': MyPayload
 *   }
 * }
 * ```
 *
 * `ipc:` 前缀让类型系统能自动把 topic 从普通事件里挑出来（见 `WireTopic`），
 * 因此 topic 名与 payload 类型只有一个来源，`ctx.ipc.emit` / `ctx.on` 都会跟着报错。
 */
export const RUNTIME_TOPIC_PREFIX = 'ipc:'

/** 已登记的跨进程 topic（由前缀自动推导，无需手写清单） */
export type WireTopic = Extract<keyof Events, `ipc:${string}`>

/** 某个 topic 的 payload 类型 */
export type WirePayload<K extends WireTopic> = Parameters<Events[K]>[0]

declare module 'cordis' {
  interface Events {
    /** 内核广播：插件集合或任一插件状态变化（主进程 → 渲染进程） */
    'ipc:plugins/changed'(snapshot: RuntimeSnapshot): void
  }
}

/**
 * 判断一个 topic 是否走跨进程通道。
 *
 * 运行期只能靠前缀判断：`Events` 是纯类型，编译后被擦除。
 */
export function isRuntimeTopic(topic: string): boolean {
  return topic.startsWith(RUNTIME_TOPIC_PREFIX)
}

/**
 * 在本地派发一个跨进程 topic。
 *
 * 主进程广播与渲染端边界适配器都用它，保证两边派发名字一致；
 * 动态字符串因此集中在这里做一次类型断言，而不是散落在调用点。
 */
export function emitRuntime(ctx: Context, topic: string, payload?: unknown): void {
  ;(ctx as unknown as { emit(name: string, payload?: unknown): void }).emit(topic, payload)
}
