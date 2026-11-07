import type { PluginId } from '@mics/sdk'

/**
 * 宿主 ⇄ 插件子进程的协议。
 *
 * 只走结构化克隆（`fork` 的 `serialization: 'advanced'`），不做 JSON 编解码——
 * 大块数据与 Date / Map 都能原样过界。
 */

export interface PluginPaths {
  userData: string
  pluginDir: string
  temp: string
  home: string
}

export interface PluginAppInfo {
  version: string
  isDev: boolean
}

/** 子进程启动后收到的第一帧 */
export interface BootstrapMessage {
  t: 'bootstrap'
  pluginId: PluginId
  /** 插件主进程入口的绝对路径 */
  entry: string
  /** 该插件当前的存储快照；worker 侧保持同步 API，写入异步回传 */
  storage: Record<string, unknown>
  paths: PluginPaths
  app: PluginAppInfo
}

export interface InvokeMessage {
  t: 'invoke'
  id: number
  method: string
  params?: unknown
}

/**
 * 宿主派发事件给子进程。
 *
 * - `emit`：只通知，不关心返回值；
 * - `waterfall`：监听器可以改写结果，必须等它返回。
 */
export interface EventMessage {
  t: 'event'
  id: number
  topic: string
  mode: 'emit' | 'waterfall'
  payload?: unknown
}

export type HostToWorker = BootstrapMessage | InvokeMessage | EventMessage | { t: 'dispose' }

export type WorkerToHost =
  | { t: 'ready'; methods: string[] }
  | { t: 'failed'; stage: 'import' | 'apply'; message: string }
  | { t: 'register'; method: string }
  | { t: 'unregister'; method: string }
  | { t: 'storage:set'; key: string; value: unknown }
  | { t: 'storage:delete'; key: string }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event-result'; id: number; ok: true; value: unknown }
  | { t: 'event-result'; id: number; ok: false; error: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'disposed' }

/** 写入合并窗口：宿主不会为每个 `set` 写一次盘 */
export const STORAGE_FLUSH_MS = 100
