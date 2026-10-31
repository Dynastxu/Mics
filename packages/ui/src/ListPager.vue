<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  page: number
  pageCount: number
}>()

const emit = defineEmits<{ change: [page: number] }>()

/** 页码较多时只保留首尾与当前页附近，中间用省略号折叠 */
const items = computed<Array<number | 'gap'>>(() => {
  const count = Math.max(1, props.pageCount)
  if (count <= 7) return Array.from({ length: count }, (_value, index) => index + 1)

  const values = new Set<number>([1, count, props.page, props.page - 1, props.page + 1])
  const sorted = [...values]
    .filter((value) => value >= 1 && value <= count)
    .sort((a, b) => a - b)
  const result: Array<number | 'gap'> = []
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1]
    if (previous !== undefined && value - previous > 1) result.push('gap')
    result.push(value)
  })
  return result
})

function goTo(next: number): void {
  if (next < 1 || next > props.pageCount || next === props.page) return
  emit('change', next)
}
</script>

<template>
  <nav class="catalog-pager" aria-label="分页">
    <button
      class="catalog-pager__button catalog-pager__arrow"
      type="button"
      :disabled="page <= 1"
      aria-label="上一页"
      title="上一页"
      @click="goTo(page - 1)"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m15 6-6 6 6 6" />
      </svg>
    </button>
    <template v-for="(item, index) in items" :key="`${item}-${index}`">
      <span v-if="item === 'gap'" class="catalog-pager__gap">…</span>
      <button
        v-else
        class="catalog-pager__button"
        :class="{ 'is-active': item === page }"
        type="button"
        :aria-current="item === page ? 'page' : undefined"
        @click="goTo(item)"
      >
        {{ item }}
      </button>
    </template>
    <button
      class="catalog-pager__button catalog-pager__arrow"
      type="button"
      :disabled="page >= pageCount"
      aria-label="下一页"
      title="下一页"
      @click="goTo(page + 1)"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  </nav>
</template>

<style scoped>
.catalog-pager {
  position: sticky;
  /* 分页条贴窗口底部：shell 的滚动容器底部留了内边距，sticky 的 bottom
     以内容盒为基准，减去这段内边距才能落到窗口底部附近 */
  bottom: calc(16px - var(--mics-page-pad-bottom, 40px));
  z-index: 2;
  align-self: center;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 5px;
  border: 1px solid var(--mics-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--mics-bg-elevated) 86%, transparent);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.35);
  backdrop-filter: blur(12px);
}

.catalog-pager__button {
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border-radius: 999px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  transition: background 0.12s ease, color 0.12s ease;
}

.catalog-pager__arrow {
  display: grid;
  place-items: center;
  padding: 0;
}

.catalog-pager__button:hover:not(:disabled) {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.catalog-pager__button.is-active {
  background: var(--mics-accent);
  color: var(--mics-accent-fg);
}

.catalog-pager__button:disabled {
  opacity: 0.35;
  cursor: default;
}

.catalog-pager__gap {
  padding: 0 2px;
  color: var(--mics-fg-muted);
  font-size: 12px;
}
</style>
