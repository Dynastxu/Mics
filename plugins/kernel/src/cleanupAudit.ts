import { ipcMain } from 'electron'

interface Registration {
  stack: string
  at: number
}

interface ListenerRegistration extends Registration {
  listener: (...args: unknown[]) => void
}

export interface IpcRegistrationSnapshot {
  at: number
  handlers: Map<string, Registration>
  listeners: Map<string, ListenerRegistration[]>
}

let installed = false
const handlers = new Map<string, Registration>()
const listeners = new Map<string, ListenerRegistration[]>()

function captureStack(): string {
  return new Error().stack?.split('\n').slice(2, 6).join('\n') ?? ''
}

function removeListenerRecord(
  channel: string,
  listener: (...args: unknown[]) => void,
): void {
  const entries = listeners.get(channel)
  if (!entries) return
  const index = entries.findIndex((entry) => entry.listener === listener)
  if (index >= 0) entries.splice(index, 1)
  if (!entries.length) listeners.delete(channel)
}

/** 只在开发模式调用；包装 ipcMain 的注册入口，记录「谁在什么时候注册了什么」 */
export function installIpcAudit(): void {
  if (installed) return
  installed = true
  try {
    // 下面全部是 Electron 公开 API 的包装；某个平台不允许改写时只放弃审计，
    // 不能让开发模式因为一个诊断工具而起不来。
    wrapIpcMain()
  } catch (error) {
    console.warn(`[mics.cleanup] 安装 ipcMain 审计失败：${(error as Error).message}`)
  }
}

function wrapIpcMain(): void {
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, { stack: captureStack(), at: Date.now() })
    return originalHandle(channel, listener as never)
  }) as typeof ipcMain.handle

  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain)
  ipcMain.removeHandler = ((channel: string) => {
    handlers.delete(channel)
    return originalRemoveHandler(channel)
  }) as typeof ipcMain.removeHandler

  const originalOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = ((channel: string, listener: (...args: unknown[]) => void) => {
    const entries = listeners.get(channel) ?? []
    entries.push({ listener, stack: captureStack(), at: Date.now() })
    listeners.set(channel, entries)
    return originalOn(channel, listener as never)
  }) as typeof ipcMain.on

  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain)
  ipcMain.removeListener = ((channel: string, listener: (...args: unknown[]) => void) => {
    removeListenerRecord(channel, listener)
    return originalRemoveListener(channel, listener as never)
  }) as typeof ipcMain.removeListener

  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain)
  ipcMain.removeAllListeners = (function (
    this: typeof ipcMain,
    channel?: string,
  ): typeof ipcMain {
    if (arguments.length === 0) {
      listeners.clear()
      return originalRemoveAllListeners()
    }
    listeners.delete(channel as string)
    return originalRemoveAllListeners(channel as never)
  }) as typeof ipcMain.removeAllListeners
}

export function snapshotIpcRegistrations(): IpcRegistrationSnapshot {
  return {
    at: Date.now(),
    handlers: new Map(handlers),
    listeners: new Map(
      [...listeners.entries()].map(([channel, entries]) => [channel, [...entries]]),
    ),
  }
}

function countListeners(snapshot: IpcRegistrationSnapshot): number {
  let total = 0
  for (const entries of snapshot.listeners.values()) total += entries.length
  return total
}

function stacksOf(entries: Registration[]): string {
  return entries
    .slice(-3)
    .map((entry) => entry.stack)
    .filter(Boolean)
    .join('\n---\n')
}

/**
 * 对比两次快照；只在注册数量增长时告警。
 *
 * 第一次重载没有基线，调用方只保存快照不告警；第二次开始比较，
 * 因此「同一个插件连续重载 10 次数量不增长」可以直接在控制台看到结论。
 */
export function reportIpcRegistrations(
  pluginId: string,
  previous: IpcRegistrationSnapshot | undefined,
  current: IpcRegistrationSnapshot,
  warn: (message: string) => void,
): void {
  if (!previous) return

  const addedHandlers = [...current.handlers.keys()].filter(
    (channel) => !previous.handlers.has(channel),
  )
  if (addedHandlers.length > 0) {
    const stacks = stacksOf(addedHandlers.map((channel) => current.handlers.get(channel)!).filter(Boolean))
    warn(
      `插件 ${pluginId} 重载后多出 ${addedHandlers.length} 个 ipcMain.handle：${addedHandlers.join(', ')}` +
        (stacks ? `\n${stacks}` : ''),
    )
  }

  const previousListeners = countListeners(previous)
  const currentListeners = countListeners(current)
  if (currentListeners > previousListeners) {
    const extra: Registration[] = []
    for (const [channel, entries] of current.listeners) {
      const before = previous.listeners.get(channel)?.length ?? 0
      if (entries.length > before) extra.push(...entries.slice(before))
    }
    warn(
      `插件 ${pluginId} 重载后多出 ${currentListeners - previousListeners} 个 ipcMain 监听器` +
        (extra.length ? `\n${stacksOf(extra)}` : ''),
    )
  }
}
