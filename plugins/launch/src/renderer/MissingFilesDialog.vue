<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { MissingFile } from '../shared'

const props = defineProps<{
  open: boolean
  instanceName: string
  files: MissingFile[]
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

/** 只列前几项，避免一个坏掉的实例把弹窗撑得比屏幕还高 */
const PREVIEW_LIMIT = 3
const confirmButton = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    confirmButton.value?.focus()
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="launch-dialog"
      role="presentation"
      @click.self="emit('cancel')"
      @keydown.esc.stop.prevent="emit('cancel')"
    >
      <div
        class="launch-dialog__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-files-title"
      >
        <h2 id="missing-files-title" class="launch-dialog__title">文件不完整</h2>
        <p class="launch-dialog__text">
          「{{ instanceName }}」缺少 {{ files.length }} 个必要文件，补全后才能启动。
        </p>

        <ul v-if="files.length" class="launch-dialog__files">
          <li v-for="file in files.slice(0, PREVIEW_LIMIT)" :key="file.path">
            {{ file.label }}
          </li>
          <li v-if="files.length > PREVIEW_LIMIT" class="launch-dialog__more">
            还有 {{ files.length - PREVIEW_LIMIT }} 个…
          </li>
        </ul>

        <div class="launch-dialog__actions">
          <button class="mics-button mics-button--ghost" type="button" @click="emit('cancel')">
            取消
          </button>
          <button
            ref="confirmButton"
            class="mics-button mics-button--primary"
            type="button"
            @click="emit('confirm')"
          >
            补全并下载
          </button>
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
  width: min(400px, 100%);
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
  margin: 8px 0 12px;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.launch-dialog__files {
  margin: 0 0 18px;
  padding: 10px 12px;
  max-height: 132px;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}

.launch-dialog__more {
  color: var(--mics-fg-muted);
  opacity: 0.7;
}

.launch-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
