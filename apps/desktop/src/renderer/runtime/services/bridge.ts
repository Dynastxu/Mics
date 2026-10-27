import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { BridgeApi, Disposable, MicsBridge, PluginId, RuntimeEventEnvelope } from '@mics/sdk'

/**
 * 对 window.mics（preload 注入）的薄封装。
 *
 * 注意：on() 只返回原始 disposer，不在这里挂 effect——
 * 由调用方（插件）决定把清理挂到哪个 fiber 上。
 */
export class BridgeService extends Service {
  private readonly api: MicsBridge

  constructor(ctx: Context) {
    super(ctx, 'bridge')
    if (!window.mics) {
      throw new Error('[mics] preload 未注入 window.mics（是否在 Electron 之外打开了页面？）')
    }
    this.api = window.mics
  }

  get versions(): Record<string, string> {
    return this.api.versions
  }

  get platform(): string {
    return this.api.platform
  }

  invoke<T = unknown>(
    target: PluginId,
    method: string,
    params?: unknown,
    callerId?: PluginId,
  ): Promise<T> {
    return this.api.rpc.invoke<T>(target, method, params, callerId)
  }

  on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): Disposable {
    return this.api.events.on(topic, listener)
  }

  emit(topic: string, payload?: unknown, callerId?: PluginId): void {
    this.api.events.emit(topic, payload, callerId)
  }
}

export type { BridgeApi }
