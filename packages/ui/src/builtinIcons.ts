/**
 * line-md 里没有对应名字时使用的内置图标。
 *
 * 这些图标原本是静态 path，这里按 line-md 的做法补上 SMIL 入场动画：
 * 用 `stroke-dasharray` + `stroke-dashoffset` 把轮廓“画”出来，多笔触依次错开。
 *
 * 与 line-md 的区别是长度不写死，而是用 `pathLength="1"` 把每条路径归一化，
 * 所以 dasharray 固定为 1、dashoffset 从 1 回到 0 即可，改路径也不用重算长度。
 * 圆/圆角矩形一律写成 path，不依赖基础图形对 pathLength 的支持。
 *
 * 调参速查（每笔一支 = drawn(...) 里的一个对象）：
 *   d       路径。画入方向由路径起点决定，起点就是先出现的那一端
 *   dur     这一笔从无到有的时长，默认 0.5 秒；整体变慢就把所有 dur 一起调大
 *   delay   什么时候开始画，默认 0；用来做先后错开，0.05～0.15 秒比较自然
 *   reverse 反向画（从路径终点回到起点）
 *   ease    缓动，SMIL keySplines 写法，如 '0.4 0 0.2 1'；不填就是线性，与 line-md 一致
 *   from    起始位移（"x y"）：这一笔画完后先停在这里，再滑回最终位置，
 *           用来做 Mod 图标那种「拼好再分出去」的动作；配合 slideAt / slideDur 调时机
 *   想彻底不画：把这一项换成普通 '<path d="…"/>'
 *
 * 注意：动画的起点状态（dashoffset=1、起始位移）只写在动画里，基础属性保持最终形态，
 * 这样动画没跑起来时图标也是完整的；begin 不用管，deferSmilBody 会统一改成 indefinite，
 * 交给播放门启动。
 */

type Shape = {
  /** path 的 d */
  d: string
  /** 延迟（秒），用于多笔触的先后顺序 */
  delay?: number
  /** 单笔绘制时长（秒） */
  dur?: number
  /** 反向画：从路径终点回到起点 */
  reverse?: boolean
  /** 缓动曲线（SMIL keySplines），不填为线性 */
  ease?: string
  /** 起始位移（"x y"）：先停在这里，再滑回最终位置 */
  from?: string
  /** 滑出开始的时刻（秒），默认 0.6 */
  slideAt?: number
  /** 滑出时长（秒），默认 0.3 */
  slideDur?: number
}

/** 把若干笔画拼成带「画入」动画的 body；线宽对齐 line-md（2） */
function drawn(...shapes: Shape[]): string {
  const strokes = shapes
    .map(
      ({ d, delay = 0, dur = 0.5, reverse = false, ease, from, slideAt = 0.6, slideDur = 0.3 }) => {
        // 还没轮到的笔画先藏起来。只写 begin 延迟的话，动画开播前它会完整显示一下，
        // 等于先亮后画；用一段 set 把 dashoffset 顶到 1 盖住这段空档。
        const hide =
          delay > 0 ? `<set attributeName="stroke-dashoffset" to="1" dur="${delay}s"/>` : ''
        const begin = delay > 0 ? ` begin="${delay}s"` : ''
        const values = reverse ? '-1;0' : '1;0'
        const timing = ease ? ` calcMode="spline" keyTimes="0;1" keySplines="${ease}"` : ''

        // 先停在 from，再滑回 0 0；keyTimes 用“停住/开始滑”占整段的比例
        let move = ''
        if (from) {
          const total = Number(Math.max(delay + dur, slideAt + slideDur).toFixed(3))
          const hold = (slideAt / total).toFixed(3)
          move =
            `<animateTransform attributeName="transform" type="translate" dur="${total}s" ` +
            `values="${from};${from};0 0" keyTimes="0;${hold};1"/>`
        }

        return (
          `<path pathLength="1" stroke-dasharray="1" d="${d}">` +
          hide +
          `<animate fill="freeze" attributeName="stroke-dashoffset" dur="${dur}s" values="${values}"${timing}${begin}/>` +
          move +
          `</path>`
        )
      }
    )
    .join('')
  return `<g stroke-width="2">${strokes}</g>`
}

export const BUILTIN_ICONS: Record<string, string> = {
  play: '<path d="M7 4.5v15l13-7.5-13-7.5Z" fill="currentColor" stroke="none"/>',
  settings:
    '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/>' +
    '<path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/>' +
    '<path d="M4 18h9"/><path d="M17 18h3"/><circle cx="15" cy="18" r="2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',

  // 下面这些是导航里正在用的、line-md 没有对应名字的图标
  cube: drawn(
    {
      d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
      dur: 0.6
    },
    { d: 'm3.3 7 8.7 5 8.7-5', delay: 0.18, dur: 0.4 },
    { d: 'M12 22V12', delay: 0.32, dur: 0.35 }
  ),
  blocks: drawn(
    {
      // 先画少了一格的「田」：大方块（缺右上角）
      d: 'M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3',
      dur: 0.45
    },
    {
      // 小方块先补进缺口拼成完整的「田」，停一下再往右上分出去（-4 4 正好是缺口到终点的位移）
      d: 'M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
      delay: 0.35,
      dur: 0.2,
      from: '-4 4',
      slideAt: 0.6,
      slideDur: 0.3
    }
  ),
  archive: drawn(
    { d: 'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', dur: 0.45 },
    { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', delay: 0.12, dur: 0.5 },
    { d: 'M10 12h4', delay: 0.3, dur: 0.3 }
  ),
  database: drawn(
    { d: 'M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0', dur: 0.5 },
    { d: 'M3 5v14a9 3 0 0 0 18 0V5', delay: 0.14, dur: 0.55 },
    { d: 'M3 12a9 3 0 0 0 18 0', delay: 0.36, dur: 0.4 }
  ),
  sparkles: drawn(
    {
      d: 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z',
      dur: 0.6
    },
    { d: 'M5 3v4', delay: 0.28, dur: 0.25 },
    { d: 'M19 17v4', delay: 0.36, dur: 0.25 },
    { d: 'M3 5h4', delay: 0.44, dur: 0.25 },
    { d: 'M17 19h4', delay: 0.52, dur: 0.25 }
  ),
  plugin: drawn(
    // 四颗菱形先拼成「斜着的田」（2×2 菱形，中心在 12,12），再各自向外散到最终位置；
    // from 是「拼合位置 - 最终位置」的位移
    {
      d: 'M12 2.5 15.5 6 12 9.5 8.5 6 12 2.5Z',
      dur: 0.4,
      from: '0 2.5',
      slideAt: 0.45,
      slideDur: 0.35
    },
    {
      d: 'M5.5 9 9 12.5 5.5 16 2 12.5 5.5 9Z',
      dur: 0.4,
      from: '3 -0.5',
      slideAt: 0.45,
      slideDur: 0.35
    },
    {
      d: 'M18.5 9 22 12.5 18.5 16 15 12.5 18.5 9Z',
      dur: 0.4,
      from: '-3 -0.5',
      slideAt: 0.45,
      slideDur: 0.35
    },
    {
      d: 'M12 15.5 15.5 19 12 22.5 8.5 19 12 15.5Z',
      dur: 0.4,
      from: '0 -3.5',
      slideAt: 0.45,
      slideDur: 0.35
    }
  ),
  sliders: drawn(
    { d: 'M4 21v-7', dur: 0.3 },
    { d: 'M4 10V3', delay: 0.06, dur: 0.3 },
    { d: 'M12 21v-9', delay: 0.12, dur: 0.3 },
    { d: 'M12 8V3', delay: 0.18, dur: 0.3 },
    { d: 'M20 21v-5', delay: 0.24, dur: 0.3 },
    { d: 'M20 12V3', delay: 0.3, dur: 0.3 },
    { d: 'M1 14h6', delay: 0.36, dur: 0.3 },
    { d: 'M9 8h6', delay: 0.42, dur: 0.3 },
    { d: 'M17 16h6', delay: 0.48, dur: 0.3 }
  ),
  activity: drawn({
    d: 'M22 12h-2.5a2 2 0 0 0-1.9 1.5l-2.4 8.3a.25.25 0 0 1-.48 0L9.2 2.2a.25.25 0 0 0-.48 0L6.4 10.5A2 2 0 0 1 4.5 12H2',
    // 路径是从右端写起来的；反向画才是「进度从左往右推进」的观感
    dur: 0.65,
    reverse: true
  })
}
