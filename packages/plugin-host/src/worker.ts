import { Context, Service } from 'cordis'
import * as CordisRuntime from 'cordis'
import type { Fiber, Plugin } from 'cordis'
import { FIBER_ACTIVE, type PluginId } from '@mics/sdk'
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

class RemoteHostService extends Service {
  static inject: string[] = []

  readonly paths: PluginPaths
  readonly app: PluginAppInfo
  readonly pluginId: PluginId

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

process.on('message', (message: HostToWorker) => {
  if (message.t === 'bootstrap') void start(message)
  else if (message.t === 'invoke') void invoke(message)
  else if (message.t === 'dispose') void stop()
})

process.on('uncaughtException', (error) => {
  send({ t: 'log', level: 'error', message: `未捕获异常：${error.message}` })
})
process.on('unhandledRejection', (reason) => {
  send({ t: 'log', level: 'error', message: `未处理的 Promise 拒绝：${String(reason)}` })
})
