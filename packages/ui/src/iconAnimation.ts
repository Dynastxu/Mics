/**
 * 图标动画的播放时机。
 *
 * line-md 的动画是 SVG SMIL，`begin` 要么缺省（等价于 `0s`），要么是固定延迟，
 * 图标一插入文档就开始计时。图标要等内核就绪后才挂载，窗口又要等
 * `ready-to-show` 才显示，于是窗口出现时一次性动画多半已经播完。
 * Ctrl+R 之所以正常，是因为它在可见窗口里重新加载文档，动画从头开始。
 *
 * 所以这里不信任 SMIL 的默认时间基准：渲染前先把所有动画改成
 * `begin="indefinite"` 并记下原始延迟，等播放门放行后再用 `beginElementAt`
 * 从当前时间启动，既保留 line-md 的编排延迟，也保证动画一定播给用户看。
 */

import type { InjectionKey } from 'vue'

/** SMIL 动画元素；line-md 只用到前三种，animateMotion 一并兜住 */
const SMIL_ELEMENTS = new Set(['animate', 'animateTransform', 'set', 'animateMotion'])

/** SMIL 标签：属性值里不会出现 `>`，可以整体匹配 */
const SMIL_TAG = /<(animate|animateTransform|set)\b([^>]*)>/gs

/** 记录被延迟的原始延迟（秒），重复调度时不必再解析 begin */
const DELAY_ATTR = 'data-mics-delay'

/** 迟迟等不到可见时的兜底：不能让图标停在动画开始前的空状态 */
const VISIBILITY_TIMEOUT_MS = 3000

/** 把 begin 解析成秒；无法解析（indefinite、事件名、多段 begin）时返回 null */
function parseDelay(begin: string | null): number | null {
  if (begin === null) return 0
  const value = begin.trim()
  if (value === '') return 0

  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value)
  if (!match) return null

  const amount = Number(match[1])
  return match[2] === 'ms' ? amount / 1000 : amount
}

function delayOf(element: Element): number | null {
  const stored = element.getAttribute(DELAY_ATTR)
  if (stored !== null) {
    const value = Number(stored)
    return Number.isFinite(value) ? value : 0
  }
  return parseDelay(element.getAttribute('begin'))
}

/**
 * 渲染前改写整段图标 body：SMIL 动画一律改成 `begin="indefinite"`，
 * 原延迟记进 `data-mics-delay`，由 deferSmil 在播放门放行时启动。
 */
export function deferSmilBody(body: string): string {
  return body.replace(SMIL_TAG, (tag: string, name: string, attrs: string) => {
    const begin = /\sbegin\s*=\s*"([^"]*)"/.exec(attrs)
    const delay = parseDelay(begin?.[1] ?? null)
    if (delay === null) return tag

    const selfClosing = /\/\s*$/.test(attrs)
    const rest = attrs
      .replace(/\/\s*$/, '')
      .replace(/\s*begin\s*=\s*"[^"]*"/, '')
      .replace(/\s*data-mics-delay\s*=\s*"[^"]*"/, '')
      .trimEnd()

    return `<${name}${rest} begin="indefinite" data-mics-delay="${delay}"${selfClosing ? ' /' : ''}>`
  })
}

/**
 * 接管 root 内已经渲染的 SMIL 动画，返回按原延迟启动它们的函数。
 * begin 无法解析的动画保持原样，也不会被启动。
 */
export function deferSmil(root: ParentNode): () => void {
  const pending: Array<{ animation: SVGAnimationElement; delay: number }> = []

  // 用 localName 判断而不是标签选择器：SVG 标签大小写敏感，选择器容易漏掉 animateTransform
  for (const element of root.querySelectorAll('*')) {
    if (!SMIL_ELEMENTS.has(element.localName)) continue
    const animation = element as SVGAnimationElement
    const delay = delayOf(animation)
    if (delay === null) continue

    if (!animation.hasAttribute(DELAY_ATTR)) {
      animation.setAttribute(DELAY_ATTR, String(delay))
      animation.setAttribute('begin', 'indefinite')
    }
    pending.push({ animation, delay })
  }

  return (): void => {
    for (const { animation, delay } of pending) animation.beginElementAt(delay)
  }
}
/**
 * 播放门：决定图标动画什么时候可以开始。
 *
 * UI 包不依赖宿主（壳层 / 插件），默认实现看文档可见性；
 * 桌面壳层会 provide 一个以主进程窗口状态为准的实现，
 * 因为隐藏窗口里 `document.visibilityState` 并不可信。
 */
export interface IconPlaybackGate {
  /** 可见时立即执行 run，否则等到可见；返回取消等待的函数 */
  whenVisible(run: () => void): () => void
}

export const iconPlaybackGateKey: InjectionKey<IconPlaybackGate> = Symbol('mics.icon-playback-gate')

/**
 * 文档可见时立即执行；已在后台则等到可见（或兜底超时）再执行。
 * 返回取消等待的函数，组件卸载时应调用。
 */
export function whenDocumentVisible(run: () => void): () => void {
  if (document.visibilityState === 'visible') {
    run()
    return () => {}
  }

  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const stopWaiting = (): void => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const start = (): void => {
    if (settled) return
    settled = true
    stopWaiting()
    run()
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') start()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  timer = setTimeout(start, VISIBILITY_TIMEOUT_MS)

  return (): void => {
    settled = true
    stopWaiting()
  }
}

/** 默认播放门：宿主没有提供窗口信号时，退回到 Page Visibility */
export const documentVisibilityGate: IconPlaybackGate = {
  whenVisible: whenDocumentVisible
}
