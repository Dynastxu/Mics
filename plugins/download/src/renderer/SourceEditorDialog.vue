<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import type { DownloadSource } from '@mics/sdk'

type TargetKey = 'launchermeta' | 'libraries' | 'resources'

const TARGET_FIELDS = [
  { key: 'launchermeta', label: '版本清单', placeholder: 'launchermeta.mojang.com' },
  { key: 'libraries', label: '依赖库', placeholder: 'libraries.minecraft.net' },
  { key: 'resources', label: '资源文件', placeholder: 'resources.download.minecraft.net' },
] as const satisfies ReadonlyArray<{
  key: TargetKey
  label: string
  placeholder: string
}>

const props = defineProps<{
  open: boolean
  /** 传入现有条目表示编辑；null 表示新建 */
  source: DownloadSource | null
}>()

const emit = defineEmits<{
  submit: [source: DownloadSource]
  cancel: []
}>()

const draft = reactive<Record<'label' | TargetKey, string>>({
  label: '',
  launchermeta: '',
  libraries: '',
  resources: '',
})

const nameInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    draft.label = props.source?.label ?? ''
    draft.launchermeta = props.source?.launchermeta ?? ''
    draft.libraries = props.source?.libraries ?? ''
    draft.resources = props.source?.resources ?? ''
    await nextTick()
    nameInput.value?.focus()
  },
)

function submit(): void {
  emit('submit', {
    label: draft.label.trim(),
    launchermeta: draft.launchermeta.trim(),
    libraries: draft.libraries.trim(),
    resources: draft.resources.trim(),
    enabled: props.source?.enabled ?? true,
  })
}

function cancel(): void {
  emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="source-dialog"
      role="presentation"
      @click.self="cancel"
      @keydown.esc.stop.prevent="cancel"
    >
      <form
        class="source-dialog__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-dialog-title"
        @submit.prevent="submit"
      >
        <h2 id="source-dialog-title" class="source-dialog__title">
          {{ source ? '编辑下载源' : '添加下载源' }}
        </h2>

        <div class="source-dialog__fields">
          <label class="source-dialog__field">
            <span class="source-dialog__label">名称</span>
            <input
              ref="nameInput"
              v-model="draft.label"
              class="mics-input"
              autocomplete="off"
            />
          </label>

          <label v-for="field in TARGET_FIELDS" :key="field.key" class="source-dialog__field">
            <span class="source-dialog__label">{{ field.label }}</span>
            <input
              v-model="draft[field.key]"
              class="mics-input mics-mono"
              :placeholder="field.placeholder"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
        </div>

        <div class="source-dialog__footer">
          <button class="mics-button mics-button--ghost" type="button" @click="cancel">
            取消
          </button>
          <button class="mics-button mics-button--primary" type="submit">确定</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.source-dialog {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.source-dialog__box {
  width: min(520px, 100%);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.source-dialog__title {
  margin: 0 0 16px;
  font-size: 14px;
  font-weight: 600;
}

.source-dialog__fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.source-dialog__field {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.source-dialog__label {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.source-dialog__field .mics-input {
  width: 100%;
}

.source-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

@media (max-width: 900px) {
  .source-dialog__field {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
    align-items: start;
  }
}
</style>
