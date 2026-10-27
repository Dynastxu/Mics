import { contextBridge, ipcRenderer } from 'electron'
import type { MicsBridge, PluginId, RpcResponse, RuntimeEventEnvelope } from '@mics/sdk'

type Listener = (envelope: RuntimeEventEnvelope) => void

const listeners = new Map<string, Set<Listener>>()

ipcRenderer.on('mics:event', (_event, envelope: RuntimeEventEnvelope) => {
  if (!envelope || typeof envelope.topic !== 'string') return
  for (const listener of listeners.get(envelope.topic) ?? []) listener(envelope)
  for (const listener of listeners.get('*') ?? []) listener(envelope)
})

const bridge: MicsBridge = {
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    v8: process.versions.v8 ?? '',
  },
  platform: process.platform,
  rpc: {
    invoke: async <T,>(
      target: PluginId,
      method: string,
      params?: unknown,
      callerId?: PluginId,
    ): Promise<T> => {
      const response = (await ipcRenderer.invoke('mics:rpc', {
        target,
        method,
        params,
        callerId,
      })) as RpcResponse
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.value as T
    },
  },
  events: {
    on(topic: string, listener: Listener): () => void {
      let set = listeners.get(topic)
      if (!set) {
        set = new Set()
        listeners.set(topic, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(topic)
      }
    },
    emit(topic: string, payload?: unknown, callerId?: PluginId): void {
      ipcRenderer.send('mics:event:emit', { topic, payload, callerId })
    },
  },
}

contextBridge.exposeInMainWorld('mics', bridge)
