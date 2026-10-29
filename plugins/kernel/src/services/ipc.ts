import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  Disposable,
  IpcMeta,
  MaybePromise,
  PluginId,
  RpcRequest,
  RpcResponse,
  RuntimeEventEnvelope,
} from '@mics/sdk'
import { emitEvent, pluginIdOf, waterfallEvent } from '@mics/sdk'

type Handler = (params: unknown, meta: IpcMeta) => MaybePromise<unknown>
type Listener = (payload: unknown, envelope: RuntimeEventEnvelope) => void

/**
 * 主进程侧的 IPC 服务。
 *
 * - 渲染进程通过 preload 发来 `mics:rpc`，由这里路由到「目标插件 + 方法」
 * - 路由前后各留一个挂载点：`ipc/before`（waterfall，可短路）与 `ipc/after`（观察），
 *   权限、审计、限流因此不必写进内核
 * - `ctx.ipc.handle()` 注册的处理函数会自动挂在调用方插件的 fiber 上，
 *   插件卸载时随之移除
 * - 事件通过 `mics:event` 广播到所有 webContents
 */
export class IpcService extends Service {
  static inject = ['plugins']

  private readonly baseCtx: Context
  private readonly kernelId: PluginId
  private readonly handlers = new Map<PluginId, Map<string, Handler>>()
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(ctx: Context) {
    super(ctx, 'ipc')
    this.baseCtx = ctx
    this.kernelId = pluginIdOf(ctx) ?? 'mics.kernel'
  }

  *[Service.init](): Generator<() => void> {
    ipcMain.removeHandler('mics:rpc')
    ipcMain.handle('mics:rpc', this.onRpc)
    ipcMain.removeAllListeners('mics:event:emit')
    ipcMain.on('mics:event:emit', this.onEventEmit)
    yield () => {
      ipcMain.removeHandler('mics:rpc')
      ipcMain.removeAllListeners('mics:event:emit')
    }
  }

  handle<T = unknown>(
    method: string,
    handler: (params: T, meta: IpcMeta) => MaybePromise<unknown>,
  ): Disposable {
    const target = pluginIdOf(this.ctx)
    if (!target) {
      throw new Error('[mics] ipc.handle() 必须从插件上下文中调用')
    }
    let map = this.handlers.get(target)
    if (!map) {
      map = new Map()
      this.handlers.set(target, map)
    }
    if (map.has(method)) {
      throw new Error(`插件 ${target} 重复注册 RPC 方法 ${method}`)
    }
    map.set(method, handler as Handler)
    return this.ctx.effect(() => () => {
      const current = this.handlers.get(target)
      current?.delete(method)
      if (current && current.size === 0) this.handlers.delete(target)
    })
  }

  on(topic: string, listener: Listener): Disposable {
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(listener)
    return this.ctx.effect(() => () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(topic)
    })
  }

  /** 某个插件注册的方法名，按字母序；诊断用，不返回处理函数 */
  methodsOf(target: PluginId): string[] {
    return [...(this.handlers.get(target)?.keys() ?? [])].sort()
  }

  emit(topic: string, payload?: unknown): void {
    this.broadcast(topic, payload, pluginIdOf(this.ctx))
  }

  broadcast(topic: string, payload?: unknown, source?: PluginId): void {
    const envelope: RuntimeEventEnvelope = { topic, source, payload, ts: Date.now() }
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send('mics:event', envelope)
    }
    for (const listener of this.listeners.get(topic) ?? []) {
      listener(payload, envelope)
    }
  }

  /** 主进程不实现 invoke，保留给渲染进程侧 */
  invoke(): Promise<never> {
    return Promise.reject(new Error('[mics] 主进程侧不支持 ipc.invoke()'))
  }

  private onRpc = async (event: IpcMainInvokeEvent, request: RpcRequest): Promise<RpcResponse> => {
    try {
      if (!request || typeof request.target !== 'string' || typeof request.method !== 'string') {
        throw new Error('无效的 RPC 请求')
      }

      const response = await waterfallEvent(this.baseCtx, 'ipc/before', request, () =>
        this.dispatch(request),
      )
      emitEvent(this.baseCtx, 'ipc/after', request, response)
      return response
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error: { message: normalized.message, stack: normalized.stack } }
    }
  }

  /** 实际路由；不吞异常，由 onRpc 统一转成错误信封 */
  private async dispatch(request: RpcRequest): Promise<RpcResponse> {
    const info = this.ctx.plugins.get(request.target)
    if (!info) throw new Error(`未知插件 ${request.target}`)
    if (request.target !== this.kernelId && info.state !== 'active') {
      throw new Error(`插件 ${request.target} 尚未激活`)
    }
    const handler = this.handlers.get(request.target)?.get(request.method)
    if (!handler) throw new Error(`插件 ${request.target} 未提供方法 ${request.method}`)
    const value = await handler(request.params, {
      target: request.target,
      method: request.method,
      callerId: request.callerId,
    })
    return { ok: true, value }
  }

  private onEventEmit = (
    event: IpcMainEvent,
    data: { topic?: unknown; payload?: unknown; callerId?: string },
  ): void => {
    if (!data || typeof data.topic !== 'string') return
    this.broadcast(data.topic, data.payload, data.callerId)
  }
}
