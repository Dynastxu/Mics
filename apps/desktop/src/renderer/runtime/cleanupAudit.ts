import { store, viewComponents } from './store'

/**
 * 开发期清理审计（渲染端）。
 *
 * 它不阻止泄漏，只负责让泄漏可见：包装 window / document 的监听器与
 * setInterval，记录注册位置；插件重载后对比同一个插件的上一次快照，
 * 数量增长就告警并打印最近几次注册的堆栈。
 *
 * 只在 `import.meta.env.DEV` 下安装；生产构建不改变任何全局函数。
 */

interface Tracked {
  stack: string
  at: number
}

interface ListenerTracked extends Tracked {
  listener: EventListenerOrEventListenerObject
}

export interface CleanupSnapshot {
  at: number
  counts: Record<string, number>
  tracks: { label: string; stack: string; at: number }[]
}

const windowListeners = new Map<string, ListenerTracked[]>()
const documentListeners = new Map<string, ListenerTracked[]>()
const intervals = new Map<number, Tracked>()
let installed = false

function captureStack(): string {
  return new Error().stack?.split('\n').slice(2, 6).join('\n') ?? ''
}

function trackListener(
  map: Map<string, ListenerTracked[]>,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void {
  const entries = map.get(type) ?? []
  if (entries.some((entry) => entry.listener === listener)) return
  entries.push({ listener, stack: captureStack(), at: Date.now() })
  map.set(type, entries)
}

function untrackListener(
  map: Map<string, ListenerTracked[]>,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void {
  const entries = map.get(type)
  if (!entries) return
  const index = entries.findIndex((entry) => entry.listener === listener)
  if (index >= 0) entries.splice(index, 1)
  if (!entries.length) map.delete(type)
}

type AddListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => void

type RemoveListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
) => void

/** 安装审计；重复调用是幂等的 */
export function installCleanupAudit(): void {
  if (installed) return
  if (!import.meta.env.DEV) return
  installed = true
  try {
    wrapGlobals()
  } catch (error) {
    // 浏览器不允许改写时只放弃审计，不影响渲染进程启动
    console.warn(`[mics.cleanup] 安装渲染端审计失败：${(error as Error).message}`)
  }
}

function wrapGlobals(): void {
  const addWindow = window.addEventListener.bind(window) as AddListener
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    trackListener(windowListeners, type, listener)
    addWindow(type, listener, options)
  }) as typeof window.addEventListener

  const removeWindow = window.removeEventListener.bind(window) as RemoveListener
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    untrackListener(windowListeners, type, listener)
    removeWindow(type, listener, options)
  }) as typeof window.removeEventListener

  const addDocument = document.addEventListener.bind(document) as AddListener
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    trackListener(documentListeners, type, listener)
    addDocument(type, listener, options)
  }) as typeof document.addEventListener

  const removeDocument = document.removeEventListener.bind(document) as RemoveListener
  document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    untrackListener(documentListeners, type, listener)
    removeDocument(type, listener, options)
  }) as typeof document.removeEventListener

  const originalSetInterval = window.setInterval.bind(window)
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = originalSetInterval(handler, timeout, ...args)
    intervals.set(id, { stack: captureStack(), at: Date.now() })
    return id
  }) as typeof window.setInterval

  const originalClearInterval = window.clearInterval.bind(window)
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) intervals.delete(id)
    return originalClearInterval(id)
  }) as typeof window.clearInterval
}

function listenerCounts(map: Map<string, ListenerTracked[]>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [type, entries] of map) result[type] = entries.length
  return result
}

/** 当前注册数量快照；没有安装审计时只统计自定义注册表 */
export function snapshotCleanup(): CleanupSnapshot {
  const counts: Record<string, number> = {
    views: Object.keys(viewComponents).length,
    statusBar: store.runtimeStatus.length,
    styles: document.querySelectorAll('link[data-mics-style]').length,
    commands: store.commands.length,
    intervals: intervals.size,
  }
  for (const [type, count] of Object.entries(listenerCounts(windowListeners))) {
    counts[`window:${type}`] = count
  }
  for (const [type, count] of Object.entries(listenerCounts(documentListeners))) {
    counts[`document:${type}`] = count
  }

  const tracks: CleanupSnapshot['tracks'] = []
  for (const [type, entries] of windowListeners) {
    for (const entry of entries) tracks.push({ label: `window:${type}`, ...entry })
  }
  for (const [type, entries] of documentListeners) {
    for (const entry of entries) tracks.push({ label: `document:${type}`, ...entry })
  }
  for (const entry of intervals.values()) tracks.push({ label: 'intervals', ...entry })
  tracks.sort((a, b) => a.at - b.at)

  return { at: Date.now(), counts, tracks }
}

/**
 * 对比同一插件的上一次重载快照与本次快照。
 *
 * 第一次重载只建立基线；之后数量增长才告警。这样插件在 apply 里注册的
 * 长期监听器不会误报，只有「每次重载都多一份」才会被抓到。
 */
export function reportCleanup(
  pluginId: string,
  previous: CleanupSnapshot | undefined,
  current: CleanupSnapshot,
  warn: (message: string) => void,
): void {
  if (!previous) return

  for (const [label, count] of Object.entries(current.counts)) {
    const before = previous.counts[label] ?? 0
    if (count <= before) continue
    const recent = current.tracks
      .filter((track) => track.label === label && track.at > previous.at)
      .slice(-3)
    warn(
      `渲染端插件 ${pluginId} 重载后 ${label} 从 ${before} 增加到 ${count}` +
        (recent.length
          ? `\n${recent.map((track) => track.stack).filter(Boolean).join('\n---\n')}`
          : ''),
    )
  }
}
