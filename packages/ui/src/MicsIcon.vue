<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { addIcon, getIcon } from '@iconify/vue'
import lineMd from '@iconify/json/json/line-md.json'
import {
  deferSmil,
  deferSmilBody,
  documentVisibilityGate,
  iconPlaybackGateKey,
  type IconPlaybackGate
} from './iconAnimation'
import { BUILTIN_ICONS } from './builtinIcons'

/**
 * 图标组件。
 *
 * - 优先使用 Material Line Icons（line-md，MIT）：名称直接填 line-md 图标名
 *   （如 download、cog、account、play、image、folder-zip），也可带前缀 line-md:。
 *   图标按需注册，换成任意 line-md 名字都能播放入场动画。
 * - line-md 没有对应名字时退回内置图标（builtinIcons.ts，同一套 SMIL 画入动画）。
 * - motion 只有两种：once 可见时播一遍（默认）/ loop 无限循环（有 name-loop 时）。
 * - SMIL 的 begin 会在图标插入文档时就开始计时，窗口出现前动画往往已经播完；
 *   因此动画改为由播放门放行时显式启动（见 iconAnimation.ts）。
 */

/** line-md 全量图标表；按需注册，不维护白名单，任意 line-md 名字都能用 */
const icons = lineMd.icons as Record<string, FlatIcon>

type FlatIcon = {
  body?: string
  width?: number
  height?: number
}

/** 首次用到时把图标注册进 iconify 的图标集，之后直接复用 */
function lineMdBody(name: string): string | undefined {
  const registered = getIcon(`mics:${name}`)?.body
  if (registered) return registered

  const icon = icons[name]
  if (!icon?.body) return undefined
  addIcon(`mics:${name}`, {
    body: icon.body,
    width: icon.width ?? 24,
    height: icon.height ?? 24
  })
  return icon.body
}

function resolveLineMd(raw: string, motion: Motion): string | undefined {
  const name = raw.replace(/^line-md:/, '')
  const base = lineMdBody(name)
  if (!base) return undefined
  // 有 -loop 同名图标就用循环版，否则基础名本身就是一次性的入场动画
  const body = motion === 'loop' ? (lineMdBody(`${name}-loop`) ?? base) : base
  return deferSmilBody(body)
}

/** line-md 没有的名字退回内置图标；内置图标也是 SMIL 画入，走同一套调度 */
function resolveBuiltin(name: string): string | undefined {
  const body = BUILTIN_ICONS[name]
  return body ? deferSmilBody(body) : undefined
}

type Motion = 'once' | 'loop'

const props = withDefaults(
  defineProps<{
    name?: string
    size?: number
    /**
     * 动画形态：
     * - once 可见时播放一遍（默认）
     * - loop 无限循环，仅对带 -loop 版本的 line-md 图标生效
     */
    motion?: Motion
  }>(),
  {
    name: '',
    size: 18,
    motion: 'once'
  }
)

const glyph = computed(() => {
  if (!props.name) return undefined
  return resolveLineMd(props.name, props.motion) ?? resolveBuiltin(props.name)
})

const iconEl = ref<SVGSVGElement | null>(null)
let cancelWait: (() => void) | undefined

/** 壳层会 provide 以主进程窗口状态为准的播放门；插件页面退回文档可见性 */
const playbackGate = inject<IconPlaybackGate>(iconPlaybackGateKey, documentVisibilityGate)

/** 挂起动画，等播放门放行时再按原延迟启动；图标内容变化时重新调度 */
function scheduleAnimation(): void {
  cancelWait?.()
  cancelWait = undefined

  const svg = iconEl.value
  if (!svg) return
  cancelWait = playbackGate.whenVisible(deferSmil(svg))
}

onMounted(scheduleAnimation)
watch(glyph, scheduleAnimation, { flush: 'post' })
onBeforeUnmount(() => cancelWait?.())
</script>

<template>
  <svg
    v-if="glyph"
    ref="iconEl"
    class="mics-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="glyph"
  />
  <span v-else-if="name" class="mics-icon mics-icon--text" :style="{ fontSize: `${size - 1}px` }">
    {{ name }}
  </span>
</template>
