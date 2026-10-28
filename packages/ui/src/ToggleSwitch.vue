<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    /** 开关是否打开 */
    modelValue: boolean
    disabled?: boolean
    /** 供读屏器使用的名称 */
    label?: string
    /** 悬停提示 */
    title?: string
  }>(),
  { disabled: false, label: '', title: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    class="mics-switch"
    :class="{ 'is-on': modelValue }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label || undefined"
    :title="title || undefined"
    :disabled="disabled"
    @click.stop="toggle"
  >
    <span class="mics-switch__thumb" />
  </button>
</template>

<style scoped>
.mics-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--mics-border);
  border-radius: 999px;
  background: var(--mics-bg-hover);
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}

.mics-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--mics-fg-muted);
  transition:
    background-color 0.12s ease,
    transform 0.12s ease;
}

.mics-switch.is-on {
  border-color: var(--mics-accent);
  background: var(--mics-accent);
}

.mics-switch.is-on .mics-switch__thumb {
  background: var(--mics-accent-fg);
  transform: translateX(14px);
}

.mics-switch:disabled {
  cursor: default;
  opacity: 0.5;
}

.mics-switch:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 2px;
}
</style>
