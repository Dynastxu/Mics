/**
 * 启动页：在任何 UI 框架挂载之前就能画出来。
 *
 * 与 dsh 的 `BootPage` 同一思路——插件加载期间给用户一个明确的进度，而不是
 * 空白窗口或"先画错的界面、再靠用户切页面纠正"。这里不依赖 Vue / cordis，
 * 只用原生 DOM，因此可以在 `createApp()` 之前调用。
 *
 * 圆环角度按 `已激活 / 总数` 单调增长；失败时列出失败的插件 id。
 */

const STYLE_ID = 'mics-boot-style'

const CSS = `
.mics-boot {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: #101218; color: #e7e9f0;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  transition: opacity .18s ease;
}
.mics-boot__card { display: flex; flex-direction: column; align-items: center; gap: 18px; }
.mics-boot__mark { font-size: 13px; letter-spacing: .38em; font-weight: 600; opacity: .72; }
.mics-boot__ring {
  width: 44px; height: 44px; border-radius: 50%;
  background:
    radial-gradient(closest-side, #101218 0 68%, transparent 69% 100%),
    conic-gradient(#5b8cff var(--mics-boot-arc, 72deg), rgba(255,255,255,.12) 0);
  animation: mics-boot-spin 1.1s linear infinite;
}
.mics-boot__hint { font-size: 12px; opacity: .62; }
.mics-boot__failed { font-size: 12px; line-height: 1.7; max-width: 520px; text-align: center; }
.mics-boot__failed-title { color: #ff8d8d; margin-bottom: 6px; }
.mics-boot__failed-item { opacity: .8; word-break: break-all; }
@keyframes mics-boot-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mics-boot__ring { animation: none; } }
`

export class BootScreen {
  private root?: HTMLDivElement
  private ring?: HTMLDivElement
  private hint?: HTMLDivElement
  private card?: HTMLDivElement
  private mark?: HTMLDivElement
  private disposed = false
  private total = 0
  private done = 0

  /** 挂到 body 上；重复调用无副作用 */
  show(): void {
    if (this.root || this.disposed) return
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement('div')
    root.className = 'mics-boot'
    const card = document.createElement('div')
    card.className = 'mics-boot__card'
    const mark = document.createElement('div')
    mark.className = 'mics-boot__mark'
    mark.textContent = 'MICS'
    const ring = document.createElement('div')
    ring.className = 'mics-boot__ring'
    const hint = document.createElement('div')
    hint.className = 'mics-boot__hint'
    hint.textContent = '正在加载插件…'
    card.append(mark, ring, hint)
    root.append(card)
    document.body.append(root)
    this.root = root
    this.card = card
    this.mark = mark
    this.ring = ring
    this.hint = hint
    this.paint()
  }

  /** 进度：插件渲染半边已加载的数量 / 总数 */
  setProgress(done: number, total: number): void {
    this.done = Math.max(0, done)
    this.total = Math.max(0, total)
    this.paint()
  }

  /** 加载失败：把失败项列出来，保持启动页可见 */
  fail(message: string, items: readonly string[] = []): void {
    if (!this.root || !this.card) return
    const report = document.createElement('div')
    report.className = 'mics-boot__failed'
    const title = document.createElement('div')
    title.className = 'mics-boot__failed-title'
    title.textContent = message
    report.append(title)
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'mics-boot__failed-item'
      row.textContent = item
      report.append(row)
    }
    this.card.replaceChildren(this.mark ?? document.createElement('div'), report)
  }

  /** 主界面接管后淡出并移除 */
  dispose(): void {
    const root = this.root
    if (!root || this.disposed) return
    this.disposed = true
    root.style.opacity = '0'
    setTimeout(() => root.remove(), 200)
    this.root = undefined
  }

  private paint(): void {
    if (!this.ring || !this.hint) return
    const ratio = this.total === 0 ? 0 : Math.min(this.done / this.total, 1)
    // 起始 72°，最多转到 288°，与加载比例对应
    this.ring.style.setProperty('--mics-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
    this.hint.textContent =
      this.total === 0 ? '正在加载插件…' : `正在加载插件… ${this.done}/${this.total}`
  }
}

export const bootScreen = new BootScreen()

export function showBootScreen(): void {
  bootScreen.show()
}

export function setBootProgress(done: number, total: number): void {
  bootScreen.setProgress(done, total)
}

export function failBootScreen(message: string, items?: readonly string[]): void {
  bootScreen.fail(message, items)
}

export function hideBootScreen(): void {
  bootScreen.dispose()
}
