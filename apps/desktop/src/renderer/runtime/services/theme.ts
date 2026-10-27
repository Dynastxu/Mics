import type { Context } from 'cordis'
import { Service } from 'cordis'
import { store } from '../store'

const STORAGE_KEY = 'mics.theme'

/** 主题服务：把插件清单里的 CSS 变量写到 documentElement 上 */
export class ThemeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'theme')
  }

  apply(themeId: string): void {
    const theme = store.themes.find((item) => item.id === themeId) ?? store.themes.at(0)
    if (!theme) return
    const root = document.documentElement
    root.dataset.micsTheme = theme.type ?? 'dark'
    for (const [name, value] of Object.entries(theme.variables)) {
      if (name.startsWith('--')) root.style.setProperty(name, value)
    }
    store.themeId = theme.id
    try {
      localStorage.setItem(STORAGE_KEY, theme.id)
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
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
  }

  current(): string | undefined {
    return store.themeId || undefined
  }

  available(): { id: string; label: string }[] {
    return store.themes.map((theme) => ({ id: theme.id, label: theme.label }))
  }
}
