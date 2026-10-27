<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  instanceName: string
}>()

const emit = defineEmits<{
  confirm: [dontAsk: boolean]
  cancel: [dontAsk: boolean]
}>()

const dontAsk = ref(false)
const confirmButton = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    dontAsk.value = false
    await nextTick()
    confirmButton.value?.focus()
  },
)

function confirm(): void {
  emit('confirm', dontAsk.value)
}

function cancel(): void {
  emit('cancel', dontAsk.value)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="launch-dialog"
      role="presentation"
      @click.self="cancel"
      @keydown.esc.stop.prevent="cancel"
    >
      <div
        class="launch-dialog__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-dialog-title"
      >
        <h2 id="launch-dialog-title" class="launch-dialog__title">已启动</h2>
        <p class="launch-dialog__text">「{{ instanceName }}」正在运行，仍要再次启动？</p>

        <div class="launch-dialog__footer">
          <label class="launch-dialog__remember">
            <input v-model="dontAsk" type="checkbox" />
            <span>不再提示</span>
          </label>

          <div class="launch-dialog__actions">
            <button class="mics-button mics-button--ghost" type="button" @click="cancel">
              取消
            </button>
            <button
              ref="confirmButton"
              class="mics-button mics-button--primary"
              type="button"
              @click="confirm"
            >
              仍要启动
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.launch-dialog {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.launch-dialog__box {
  width: min(380px, 100%);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.launch-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.launch-dialog__text {
  margin: 8px 0 18px;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.launch-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.launch-dialog__remember {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  cursor: pointer;
}

.launch-dialog__remember input {
  margin: 0;
  accent-color: var(--mics-accent);
}

.launch-dialog__actions {
  display: flex;
  gap: 8px;
}
</style>
