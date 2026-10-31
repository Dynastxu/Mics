<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    subtitle?: string
    /** 对话框宽度上限 */
    width?: string
  }>(),
  { subtitle: '', width: '560px' },
)

const emit = defineEmits<{ close: [] }>()
const titleId = useId()

function close(): void {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog"
      role="presentation"
      @click.self="close"
      @keydown.esc.stop.prevent="close"
    >
      <div
        class="dialog__box"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :style="{ width: `min(${width}, 100%)` }"
      >
        <header class="dialog__header">
          <h2 :id="titleId" class="dialog__title">{{ title }}</h2>
          <p v-if="subtitle" class="dialog__subtitle">{{ subtitle }}</p>
          <slot name="header" />
        </header>

        <slot />

        <footer v-if="$slots.footer" class="dialog__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.dialog__box {
  display: flex;
  flex-direction: column;
  max-height: min(640px, 86vh);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.dialog__header {
  margin-bottom: 14px;
}

.dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.dialog__subtitle {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}

.dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}
</style>
