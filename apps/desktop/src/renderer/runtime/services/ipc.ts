import type { Context } from 'cordis'
import { Service } from 'cordis'
import type {
  Disposable,
  IpcMeta,
  MaybePromise,
  PluginId,
  RuntimeEventEnvelope,
} from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'

type LocalHandler = (params: unknown, meta: IpcMeta) => MaybePromise<unknown>

/**
 * 渲染进程侧的 IPC 服务：
 *   - 优先走同进程内其他插件注册的方法（插件间互调）
 *   - 否则经 preload 转发到主进程的插件
 *
 * 兄弟服务一律通过自身上下文（owner）访问：cordis 的追踪上下文属于调用方，
 * 而调用方未必声明了对应 inject。
 */
export class IpcService extends Service {
  static inject = ['bridge']

  private readonly owner: Context
  private readonly local = new Map<PluginId, Map<string, LocalHandler>>()

  constructor(ctx: Context) {
    super(ctx, 'ipc')
    this.owner = ctx
  }

  async invoke<T = unknown>(target: PluginId, method: string, params?: unknown): Promise<T> {
    const local = this.local.get(target)?.get(method)
    if (local) {
      const meta: IpcMeta = { target, method, callerId: pluginIdOf(this.ctx) }
      return (await local(params, meta)) as T
    }
    return this.owner.bridge.invoke<T>(target, method, params, pluginIdOf(this.ctx))
  }

  handle<T = unknown>(
    method: string,
    handler: (params: T, meta: IpcMeta) => MaybePromise<unknown>,
  ): Disposable {
    const target = pluginIdOf(this.ctx)
    if (!target) throw new Error('[mics] ipc.handle() 必须从插件上下文中调用')
    let map = this.local.get(target)
    if (!map) {
      map = new Map()
      this.local.set(target, map)
    }
    if (map.has(method)) throw new Error(`插件 ${target} 重复注册 RPC 方法 ${method}`)
    map.set(method, handler as LocalHandler)
    return this.ctx.effect(() => () => {
      const current = this.local.get(target)
      current?.delete(method)
      if (current && current.size === 0) this.local.delete(target)
    })
  }

  on(
    topic: string,
    listener: (payload: unknown, envelope: RuntimeEventEnvelope) => void,
  ): Disposable {
    const off = this.owner.bridge.on(topic, (envelope) => listener(envelope.payload, envelope))
    // 订阅的生命周期跟随调用方插件
    return this.ctx.effect(() => off)
  }

  emit(topic: string, payload?: unknown): void {
    this.owner.bridge.emit(topic, payload, pluginIdOf(this.ctx))
  }

  broadcast(topic: string, payload?: unknown): void {
    this.owner.bridge.emit(topic, payload)
  }
}
