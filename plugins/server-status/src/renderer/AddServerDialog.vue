<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Dialog } from '@mics/ui'
import type { ServerEdition } from '../shared'

/**
 * 添加服务器。
 *
 * 只负责收集表单：校验、去重与落盘都在主进程（`servers/add`），错误经
 * `error` 属性回传，对话框保持打开让用户改地址。
 */
const props = defineProps<{
  open: boolean
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  close: []
  submit: [input: { address: string; label: string; edition: ServerEdition }]
}>()

const address = ref('')
const label = ref('')
const edition = ref<ServerEdition>('java')
const addressInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    address.value = ''
    label.value = ''
    edition.value = 'java'
    await nextTick()
    addressInput.value?.focus()
  }
)

function close(): void {
  if (props.busy) return
  emit('close')
}

function submit(): void {
  const value = address.value.trim()
  if (props.busy || !value) return
  emit('submit', { address: value, label: label.value.trim(), edition: edition.value })
}
</script>

<template>
  <Dialog :open="open" title="添加服务器" width="440px" @close="close">
    <form class="add-server" @submit.prevent="submit">
      <label class="add-server__field">
        <span class="add-server__label">地址</span>
        <input
          ref="addressInput"
          v-model="address"
          class="mics-input"
          placeholder="play.example.com"
          spellcheck="false"
          autocomplete="off"
        />
      </label>

      <label class="add-server__field">
        <span class="add-server__label">名称</span>
        <input
          v-model="label"
          class="mics-input"
          placeholder="可选"
          maxlength="60"
          autocomplete="off"
        />
      </label>

      <label class="add-server__field">
        <span class="add-server__label">版本</span>
        <select v-model="edition" class="mics-select">
          <option value="java">Java 版</option>
          <option value="bedrock">基岩版</option>
        </select>
      </label>

      <p v-if="error" class="mics-notice add-server__error">{{ error }}</p>

      <footer class="add-server__footer">
        <button
          type="button"
          class="mics-button mics-button--ghost"
          :disabled="busy"
          @click="close"
        >
          取消
        </button>
        <button
          type="submit"
          class="mics-button mics-button--primary"
          :disabled="busy || !address.trim()"
        >
          {{ busy ? '添加中…' : '添加' }}
        </button>
      </footer>
    </form>
  </Dialog>
</template>

<style scoped>
.add-server {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.add-server__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.add-server__label {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.add-server__error {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.add-server__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
