<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  name: string
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    cancelButton.value?.focus()
  },
)

function cancel(): void {
  if (props.busy) return
  emit('cancel')
}

function confirm(): void {
  if (props.busy) return
  emit('confirm')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="mod-delete"
      role="presentation"
      @click.self="cancel"
      @keydown.esc.stop.prevent="cancel"
    >
      <div
        class="mod-delete__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mod-delete-title"
      >
        <h2 id="mod-delete-title" class="mod-delete__title">删除 Mod</h2>
        <p class="mod-delete__text">
          将删除文件「{{ name }}」。此操作不可恢复，但如果只是临时停用，请使用右侧开关。
        </p>

        <div class="mod-delete__actions">
          <button
            ref="cancelButton"
            class="mics-button mics-button--ghost"
            type="button"
            :disabled="busy"
            @click="cancel"
          >
            取消
          </button>
          <button
            class="mics-button mics-button--danger"
            type="button"
            :disabled="busy"
            @click="confirm"
          >
            {{ busy ? '正在删除…' : '删除' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mod-delete {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.mod-delete__box {
  width: min(420px, 100%);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.mod-delete__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.mod-delete__text {
  margin: 8px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.mod-delete__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
