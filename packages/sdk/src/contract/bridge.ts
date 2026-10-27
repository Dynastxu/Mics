import type { PluginId } from './manifest'
import type { RuntimeEventEnvelope } from './runtime'

/** preload 通过 contextBridge 暴露到渲染进程的 window.mics */
export interface MicsBridge {
  readonly versions: Record<string, string>
  readonly platform: string
  readonly rpc: {
    invoke<T = unknown>(
      target: PluginId,
      method: string,
      params?: unknown,
      callerId?: PluginId,
    ): Promise<T>
  }
  readonly events: {
    on(topic: string, listener: (envelope: RuntimeEventEnvelope) => void): () => void
    emit(topic: string, payload?: unknown, callerId?: PluginId): void
  }
}
