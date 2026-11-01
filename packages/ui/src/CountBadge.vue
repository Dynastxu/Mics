<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * 通用数字徽标：供导航项 rightSlot 复用。
 * 两种用法：
 *   <CountBadge :count="n" />                          静态数字
 *   <CountBadge :resolve="async () => n" :interval="1500" />  自动轮询
 * 仅在数量 > 0 时显示。
 */
const props = withDefaults(
  defineProps<{
    /** 静态数量；提供 resolve 时忽略 */
    count?: number
    /** 异步取数函数；提供后组件按 interval 自动轮询 */
    resolve?: () => number | Promise<number>
    /** 轮询间隔（ms），默认 1500 */
    interval?: number
  }>(),
  { count: 0, interval: 1500 }
)

const live = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
let seq = 0

async function poll(): Promise<void> {
  if (!props.resolve) return
  const current = ++seq
  try {
    const value = await props.resolve()
    if (current === seq) live.value = Number(value)
  } catch {
    // 数据源尚未就绪，保留上次计数值
  }
}

onMounted(() => {
  if (props.resolve) {
    void poll()
    timer = setInterval(() => void poll(), Math.max(200, props.interval))
  }
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const value = computed(() => (props.resolve ? live.value : props.count))
</script>

<template>
  <span v-if="value > 0" class="mics-count-badge">{{ value }}</span>
</template>

<style scoped>
.mics-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--mics-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
</style>