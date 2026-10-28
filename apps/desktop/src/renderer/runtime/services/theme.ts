import type { Context } from 'cordis'
import { Service } from 'cordis'
import { store } from '../store'

const STORAGE_KEY = 'mics.theme'

/** 主题服务：把插件清单里的 CSS 变量写到 documentElement 上 */
export class ThemeService extends Service {
  /** 上一次写入 documentElement 的变量，用于卸载主题时精确清理 */
  private appliedVariables: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'theme')
  }

  apply(themeId: string): void {
    const theme = store.themes.find((item) => item.id === themeId) ?? store.themes.at(0)
    if (!theme) {
      this.clear()
      return
    }

    const root = document.documentElement
    const nextVariables = Object.keys(theme.variables).filter((name) => name.startsWith('--'))
    for (const name of this.appliedVariables) {
      if (!(name in theme.variables)) root.style.removeProperty(name)
    }
    root.dataset.micsTheme = theme.type ?? 'dark'
    for (const name of nextVariables) {
      const value = theme.variables[name]
      if (value !== undefined) root.style.setProperty(name, value)
    }
    this.appliedVariables = nextVariables
    store.themeId = theme.id
    try {
      localStorage.setItem(STORAGE_KEY, theme.id)
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
  }

  /** 主题插件被禁用/卸载后，撤销它留下的变量与当前选择 */
  reconcile(): void {
    if (store.themeId && store.themes.some((theme) => theme.id === store.themeId)) return
    this.apply(store.themes.at(0)?.id ?? '')
  }

  private clear(): void {
    const root = document.documentElement
    for (const name of this.appliedVariables) root.style.removeProperty(name)
    this.appliedVariables = []
    delete root.dataset.micsTheme
    store.themeId = ''
  }

  /** 启动时恢复上次选择 */
  restore(): void {
    let saved = ''
    try {
      saved = localStorage.getItem(STORAGE_KEY) ?? ''
    } catch {
      saved = ''
    }
    const initial = store.themes.some((item) => item.id === saved)
      ? saved
      : (store.themes.at(0)?.id ?? '')
    if (initial) this.apply(initial)
    else this.clear()
  }

  current(): string | undefined {
    return store.themeId || undefined
  }

  available(): { id: string; label: string }[] {
    return store.themes.map((theme) => ({ id: theme.id, label: theme.label }))
  }
}
