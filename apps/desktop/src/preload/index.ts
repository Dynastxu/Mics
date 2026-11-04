import { contextBridge, ipcRenderer } from 'electron'
import type {
  MicsBridge,
  MicsWindowControl,
  MicsWindowResizeGesture,
  MicsWindowState,
  PluginId,
  RpcResponse,
  RuntimeEventEnvelope
} from '@mics/sdk'

type Listener = (envelope: RuntimeEventEnvelope) => void
type WindowStateListener = (state: MicsWindowState) => void

// 同步问主进程要自己的窗口 id：必须在任何插件加载前拿到，用于事件路由
const windowId = ipcRenderer.sendSync('mics:window-id') as number

const listeners = new Map<string, Set<Listener>>()
const windowStateListeners = new Set<WindowStateListener>()

ipcRenderer.on('mics:event', (_event, envelope: RuntimeEventEnvelope) => {
  if (!envelope || typeof envelope.topic !== 'string') return
  // 定向事件：只处理发给本窗口的帧（未带 target 的是广播）
  if (typeof envelope.target === 'number' && envelope.target !== windowId) return
  for (const listener of listeners.get(envelope.topic) ?? []) listener(envelope)
  for (const listener of listeners.get('*') ?? []) listener(envelope)
})

ipcRenderer.on('mics:window-state', (_event, state: MicsWindowState) => {
  if (!state || typeof state.maximized !== 'boolean') return
  for (const listener of windowStateListeners) listener(state)
})

function sendWindowControl(action: MicsWindowControl): void {
  ipcRenderer.send('mics:window-control', action)
}

const bridge: MicsBridge = {
  windowId,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    v8: process.versions.v8 ?? ''
  },
  platform: process.platform,
  windowControls: {
    minimize: () => sendWindowControl('minimize'),
    toggleMaximize: () => sendWindowControl('toggle-maximize'),
    close: () => sendWindowControl('close'),
    resizeWindow: (gesture: MicsWindowResizeGesture) =>
      ipcRenderer.send('mics:window-resize', gesture),
    getState: async () => (await ipcRenderer.invoke('mics:window-state')) as MicsWindowState,
    onStateChange(listener: WindowStateListener): () => void {
      windowStateListeners.add(listener)
      return () => {
        windowStateListeners.delete(listener)
      }
    }
  },
  rpc: {
    invoke: async <T>(
      target: PluginId,
      method: string,
      params?: unknown,
      callerId?: PluginId
    ): Promise<T> => {
      const response = (await ipcRenderer.invoke('mics:rpc', {
        target,
        method,
        params,
        callerId
      })) as RpcResponse
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.value as T
    }
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
    }
  }
}

contextBridge.exposeInMainWorld('mics', bridge)
