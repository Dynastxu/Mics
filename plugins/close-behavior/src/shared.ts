/**
 * 关闭主窗口时的行为。
 *
 * 与 `plugin.json` 里 `contributes.configuration.closeAction` 的枚举值一一对应：
 * - `ask`：每次关闭都询问（默认）；
 * - `quit`：直接退出应用；
 * - `tray`：隐藏主窗口、保留托盘图标继续运行。
 */
import type {} from 'cordis'

export type CloseAction = 'ask' | 'quit' | 'tray'

/** 存储键；storage 已按插件隔离，无需再加插件前缀 */
export const CLOSE_ACTION_KEY = 'closeAction'
/** 低内存托盘：隐藏时销毁主窗口释放渲染进程，恢复时重建 */
export const LOW_MEMORY_TRAY_KEY = 'lowMemoryTray'

/** 设置变化事件：确认框勾选「不再提示」后，已打开的设置页也能同步 */
export const CLOSE_BEHAVIOR_CHANGED = 'ipc:close-behavior/changed'

/**
 * 关闭确认框的事件。
 *
 * 主进程拦截 close 后广播 request，渲染端的全局确认框显示后回 ack；
 * 用户选择后经 `prompt/respond` RPC 把结果交回主进程。主进程没有在
 * 显示时限内收到 ack 时按最小化至托盘处理，避免界面无响应时卡住关闭。
 */
export const CLOSE_PROMPT_REQUEST = 'ipc:close-behavior/prompt/request'
export const CLOSE_PROMPT_DISMISS = 'ipc:close-behavior/prompt/dismiss'

export type ClosePromptAction = Exclude<CloseAction, 'ask'>

export interface ClosePromptRequest {
  id: string
}

export interface ClosePromptResponse {
  id: string
  action: ClosePromptAction
  remember: boolean
}

export interface ClosePromptResult {
  action: ClosePromptAction
  remember: boolean
}

export function isClosePromptAction(value: unknown): value is ClosePromptAction {
  return value === 'quit' || value === 'tray'
}

export const DEFAULT_CLOSE_ACTION: CloseAction = 'ask'
export const DEFAULT_LOW_MEMORY_TRAY = true

export interface CloseSettings {
  closeAction: CloseAction
  lowMemoryTray: boolean
}

export const CLOSE_ACTION_OPTIONS: ReadonlyArray<{ value: CloseAction; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'quit', label: '退出应用' },
  { value: 'tray', label: '最小化至托盘区' }
]

const ACTIONS = new Set<CloseAction>(CLOSE_ACTION_OPTIONS.map((option) => option.value))

export function isCloseAction(value: unknown): value is CloseAction {
  return typeof value === 'string' && ACTIONS.has(value as CloseAction)
}

/**
 * 读取时把非法值折回默认值。
 *
 * profile 默认值或手改的 JSON 都可能写进不认识的值；关闭流程不该因此卡住，
 * 因此这里做归一化，写入端（`settings/set`）仍然严格校验。
 */
export function normalizeCloseAction(value: unknown): CloseAction {
  return isCloseAction(value) ? value : DEFAULT_CLOSE_ACTION
}

export function normalizeLowMemoryTray(value: unknown): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return DEFAULT_LOW_MEMORY_TRAY
}

declare module 'cordis' {
  interface Events {
    [CLOSE_BEHAVIOR_CHANGED](settings: CloseSettings): void
    [CLOSE_PROMPT_REQUEST](request: ClosePromptRequest): void
    [CLOSE_PROMPT_DISMISS](payload: { id: string }): void
  }
}
