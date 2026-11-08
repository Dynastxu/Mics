import { Context, Service } from 'cordis'
import * as CordisRuntime from 'cordis'
import type { Fiber, Plugin } from 'cordis'
import {
  CAPABILITY_BRIDGES,
  FIBER_ACTIVE,
  isBridgeableCapability,
  type CapabilityBridgeSpec,
  type CapabilityName,
  type PluginId
} from '@mics/sdk'
import {
  STORAGE_FLUSH_MS,
  type BootstrapMessage,
  type HostToWorker,
  type PluginAppInfo,
  type PluginPaths,
  type WorkerToHost
} from './protocol'

/**
 * 插件子进程的运行时。
 *
 * 它做的事和主进程里的 cordis 一样：建上下文、挂插件、回收 effect。区别只有两个：
 *   1. `electron` 模块不存在，需要宿主能力时走 `ctx.host`；
 *   2. `ctx.ipc` / `ctx.storage` 是代理，注册与读写都回传给宿主。
 *
 * 插件源码里只有一处需要改：`app.getPath('userData')` → `ctx.host.paths.userData`。
 */

function send(message: WorkerToHost): void {
  process.send?.(message)
}

/** 宿主代做系统交互：请求在子进程发起，真正执行在宿主 */
const hostPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
let hostSeq = 0

function hostCall<T>(method: 'openExternal' | 'openPath', args: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++hostSeq
    hostPending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    send({ t: 'host-call', id, method, args })
  })
}

class RemoteIpcService extends Service {
  static inject: string[] = []

  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  constructor(ctx: Context) {
    super(ctx, 'ipc')
  }

  handle(method: string, handler: (params: unknown) => unknown): unknown {
    this.handlers.set(method, handler)
    send({ t: 'register', method })
    // this.ctx 是调用方的上下文（cordis 的 tracker），清理挂在插件 fiber 上
    return this.ctx.effect(() => () => {
      this.handlers.delete(method)
      send({ t: 'unregister', method })
    })
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`插件没有注册 RPC 方法 ${method}`)
    return await handler(params)
  }

  methods(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

class RemoteStorageService extends Service {
  static inject: string[] = []

  private readonly data = new Map<string, unknown>()
  private readonly pending = new Map<string, unknown>()
  private readonly removed = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context) {
    super(ctx, 'storage')
  }

  load(snapshot: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(snapshot)) this.data.set(key, value)
  }

  get<T>(key: string, fallback?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value)
    this.pending.set(key, value)
    this.removed.delete(key)
    this.schedule()
  }

  delete(key: string): void {
    this.data.delete(key)
    this.pending.delete(key)
    this.removed.add(key)
    this.schedule()
  }

  keys(): string[] {
    return [...this.data.keys()]
  }

  /** 立即把挂起的写入交给宿主；dispose 前必调一次 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    for (const [key, value] of this.pending) send({ t: 'storage:set', key, value })
    for (const key of this.removed) send({ t: 'storage:delete', key })
    this.pending.clear()
    this.removed.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, STORAGE_FLUSH_MS)
    // 计时器不阻止进程退出
    this.timer.unref?.()
  }
}

// ---------------------------------------------------------------------------
// 能力代理
// ---------------------------------------------------------------------------

const capPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
let capSeq = 0
const capSubs = new Map<number, (...args: unknown[]) => void>()
let capSubSeq = 0

function capCall<T>(
  cap: string,
  method: string,
  args: unknown,
  target?: number,
  sub?: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++capSeq
    capPending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    send({ t: 'cap-call', id, cap, method, args, target, sub })
  })
}

/** 函数参数替换成订阅 id；宿主侧再还原成真回调 */
function encodeArg(value: unknown): unknown {
  if (typeof value === 'function') {
    const sub = ++capSubSeq
    capSubs.set(sub, value as (...args: unknown[]) => void)
    return { __micsSub: sub }
  }
  if (Array.isArray(value)) return value.map(encodeArg)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = encodeArg(item)
    return out
  }
  return value
}

/**
 * 句柄代理。
 *
 * `ready` 是宿主返回的句柄引用：方法调用前先等它落地。
 * 之所以允许“延迟”，是因为能力契约里有同步方法（`FILE_TRANSFER.create` 返回句柄
 * 而不是 Promise），代理必须保持同步签名，把等待挪到每次方法调用里。
 */
function wrapHandle(
  spec: NonNullable<CapabilityBridgeSpec['handle']>,
  cap: string,
  ready: Promise<Record<string, unknown>>,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  const local: Record<string, unknown> = { ...fields }
  const handleId = async (): Promise<number> => {
    const ref = await ready
    const id = Number(ref?.__micsHandle)
    if (!Number.isFinite(id)) throw new Error(`能力 ${cap} 没有返回可用的句柄`)
    return id
  }

  return new Proxy(local, {
    get(current, prop) {
      if (typeof prop !== 'string') return Reflect.get(current, prop)
      if (prop in current) return current[prop]
      if (prop === 'once') {
        return (event: string, listener: (...args: unknown[]) => void) => {
          const sub = ++capSubSeq
          capSubs.set(sub, listener)
          void handleId().then((id) => capCall(cap, 'once', event, id, sub))
          return () => {
            capSubs.delete(sub)
          }
        }
      }
      if (spec.methods.includes(prop)) {
        return async (...args: unknown[]) =>
          await capCall(cap, prop, args.map(encodeArg), await handleId())
      }
      return undefined
    }
  })
}

/** 生成能力代理：方法转发到宿主，句柄按 id 路由，回调按订阅推送 */
function wrapCapability(name: string, spec: CapabilityBridgeSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { label: 'host' }
  return new Proxy(base, {
    get(current, prop) {
      if (typeof prop !== 'string') return Reflect.get(current, prop)
      if (prop in current) return current[prop]
      if (!spec.methods.includes(prop)) return undefined

      return (...args: unknown[]) => {
        const pending = capCall(name, prop, args.map(encodeArg)) as Promise<Record<string, unknown>>
        if (!spec.handle) return pending
        // 句柄有字段（例如 `pid`）时只能异步返回：调用方本来就 await 了这个方法
        if (spec.handle.fields.length > 0) {
          return pending.then((ref) =>
            wrapHandle(spec.handle!, name, Promise.resolve(ref), (ref?.__micsFields ?? {}) as Record<string, unknown>)
          )
        }
        // 没有字段时保持同步签名：`create()` 直接返回句柄，等待被推迟到方法调用里
        return wrapHandle(spec.handle, name, pending)
      }
    }
  })
}

/**
 * 子进程侧的能力注册表。
 *
 * 能力实现留在宿主：这里只给代理。`provide()` 直接报错——能力是宿主对插件的
 * 授权，允许子进程反向注册会让沙箱失去意义。
 */
class RemoteCapabilitiesService extends Service {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'capabilities')
  }

  get<T>(name: CapabilityName): T | undefined {
    const spec = CAPABILITY_BRIDGES[name]
    if (!spec) return undefined
    return wrapCapability(name, spec) as T
  }

  require<T>(name: CapabilityName): T {
    if (!isBridgeableCapability(name)) {
      throw new Error(`能力 ${name} 不能在子进程里使用（未登记跨进程桥接）`)
    }
    return this.get<T>(name) as T
  }

  provide(): never {
    throw new Error('子进程插件不能提供能力：能力由宿主提供')
  }

  providers(): never[] {
    return []
  }

  names(): never[] {
    return []
  }

  consumers(): never[] {
    return []
  }

  consumersOf(): never[] {
    return []
  }

  onChange(): () => void {
    return () => undefined
  }
}

class RemoteHostService extends Service {

  readonly paths: PluginPaths
  readonly app: PluginAppInfo
  readonly pluginId: PluginId
  readonly shell = {
    openExternal: (url: string): Promise<void> => hostCall('openExternal', url),
    openPath: (target: string): Promise<string> => hostCall('openPath', target)
  }

  constructor(ctx: Context, pluginId: PluginId, paths: PluginPaths, app: PluginAppInfo) {
    super(ctx, 'host')
    this.pluginId = pluginId
    this.paths = paths
    this.app = app
  }
}

let ctx: Context | undefined
let fiber: Fiber | undefined
let ipc: RemoteIpcService | undefined
let storage: RemoteStorageService | undefined
let stopping = false

/**
 * 插件产物把 `cordis` 解析成 shim，运行时从 globalThis 上取。
 * 主进程由 bootstrap 设置；子进程里由这里设置，插件代码无感。
 */
;(globalThis as { __MICS_CORDIS__?: unknown }).__MICS_CORDIS__ = CordisRuntime

async function start(message: BootstrapMessage): Promise<void> {
  ctx = new Context()
  ipc = new RemoteIpcService(ctx)
  storage = new RemoteStorageService(ctx)
  storage.load(message.storage)
  new RemoteHostService(ctx, message.pluginId, message.paths, message.app)
  new RemoteCapabilitiesService(ctx)

  let module: Record<string, unknown>
  try {
    module = (await import(`file://${message.entry.replace(/\\/g, '/')}`)) as Record<string, unknown>
  } catch (error) {
    send({ t: 'failed', stage: 'import', message: error instanceof Error ? error.message : String(error) })
    return
  }

  const plugin = (module.default ?? module) as Plugin.Object<unknown>
  try {
    fiber = ctx.plugin(plugin, { pluginId: message.pluginId })
    // cordis 允许 inject 未满足时停在 pending：等一个 tick 再看状态
    await new Promise((resolve) => setTimeout(resolve, 0))
  } catch (error) {
    send({ t: 'failed', stage: 'apply', message: error instanceof Error ? error.message : String(error) })
    return
  }

  const state = (fiber as unknown as { state?: number }).state
  if (state !== FIBER_ACTIVE) {
    send({
      t: 'failed',
      stage: 'apply',
      message: `插件在子进程里没有激活（state=${String(state)}），可能是 inject 的服务缺失`
    })
    return
  }
  send({ t: 'ready', methods: ipc.methods() })
}

async function invoke(message: Extract<HostToWorker, { t: 'invoke' }>): Promise<void> {
  try {
    const value = await ipc?.call(message.method, message.params)
    send({ t: 'result', id: message.id, ok: true, value })
  } catch (error) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    await fiber?.dispose()
  } catch {
    // 插件清理抛错不应阻止退出
  }
  // 清理里可能还会写 storage，所以先 dispose 再 flush
  storage?.flush()
  send({ t: 'disposed' })
  // 让 IPC 帧有机会发出去，再退出
  setTimeout(() => process.exit(0), 30)
}

async function dispatchEvent(message: Extract<HostToWorker, { t: 'event' }>): Promise<void> {
  try {
    const target = ctx
    if (!target) throw new Error('插件上下文尚未建立')
    let value: unknown
    if (message.mode === 'waterfall') {
      // 链尾直接把传入值返回：没有监听器改写时结果不变
      value = await target.waterfall(message.topic, message.payload, () => message.payload)
    } else {
      target.emit(message.topic, message.payload)
      value = undefined
    }
    send({ t: 'event-result', id: message.id, ok: true, value })
  } catch (error) {
    send({
      t: 'event-result',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

process.on('message', (message: HostToWorker) => {
  if (message.t === 'bootstrap') void start(message)
  else if (message.t === 'invoke') void invoke(message)
  else if (message.t === 'event') void dispatchEvent(message)
  else if (message.t === 'host-result') {
    const entry = hostPending.get(message.id)
    if (!entry) return
    hostPending.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(String(message.error)))
  } else if (message.t === 'cap-result') {
    const entry = capPending.get(message.id)
    if (!entry) return
    capPending.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(String(message.error)))
  } else if (message.t === 'cap-event') {
    capSubs.get(message.sub)?.(...(message.payload ?? []))
  } else if (message.t === 'dispose') void stop()
})

process.on('uncaughtException', (error) => {
  send({ t: 'log', level: 'error', message: `未捕获异常：${error.message}` })
})
process.on('unhandledRejection', (reason) => {
  send({ t: 'log', level: 'error', message: `未处理的 Promise 拒绝：${String(reason)}` })
})
