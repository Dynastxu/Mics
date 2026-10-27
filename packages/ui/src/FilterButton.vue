<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 存在非默认筛选时，按钮上显示一个小圆点 */
    active?: boolean
    /** 放在分区标题行里时使用小号按钮 */
    small?: boolean
    label?: string
  }>(),
  { active: false, small: false, label: '筛选' },
)

/** 面板是否展开；点击按钮切换 */
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <button
    class="mics-button mics-button--ghost"
    :class="{ 'is-active': open, 'mics-button--small': small }"
    :aria-expanded="open"
    @click="open = !open"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />
    </svg>
    {{ label }}
    <span v-if="active" class="mics-button__dot" />
  </button>
</template>
