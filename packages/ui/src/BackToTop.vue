<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 是否显示；一般由页面滚动位置决定 */
    visible?: boolean
    label?: string
  }>(),
  { visible: false, label: '返回顶部' },
)

defineEmits<{ click: [] }>()
</script>

<template>
  <button
    v-if="visible"
    class="back-to-top"
    type="button"
    :title="label"
    :aria-label="label"
    @click="$emit('click')"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m6 14 6-6 6 6" />
    </svg>
  </button>
</template>

<style scoped>
.back-to-top {
  position: fixed;
  right: 24px;
  /* 底部留出状态栏 */
  bottom: 42px;
  z-index: 40;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--mics-border);
  border-radius: 50%;
  background: color-mix(in srgb, var(--mics-bg-elevated) 92%, transparent);
  color: var(--mics-fg-muted);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  backdrop-filter: blur(8px);
  transition: color 0.12s ease, border-color 0.12s ease;
}

.back-to-top:hover {
  border-color: var(--mics-accent);
  color: var(--mics-accent);
}

.back-to-top:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 2px;
}
</style>
