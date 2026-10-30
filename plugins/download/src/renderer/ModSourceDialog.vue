<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { MOD_SOURCE_KINDS, MOD_SOURCE_LABELS, defaultModApi } from '@mics/sdk'
import type { ModSource, ModSourceKind } from '@mics/sdk'

const props = defineProps<{
  open: boolean
  /** 传入现有条目表示编辑；null 表示新建 */
  source: ModSource | null
}>()

const emit = defineEmits<{
  submit: [source: ModSource]
  cancel: []
}>()

const draft = reactive<{
  label: string
  kind: ModSourceKind
  api: string
  key: string
}>({
  label: '',
  kind: 'modrinth',
  api: '',
  key: '',
})

const nameInput = ref<HTMLInputElement | null>(null)
const apiPlaceholder = computed(() => defaultModApi(draft.kind))

/** 切换来源类型时，把仍停留在旧官方地址的输入清空，让占位符提示新地址 */
function onKindInput(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as ModSourceKind
  if (!draft.api.trim() || draft.api.trim() === defaultModApi(draft.kind)) draft.api = ''
  draft.kind = next
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    draft.label = props.source?.label ?? ''
    draft.kind = props.source?.kind ?? 'modrinth'
    draft.api = props.source?.api ?? ''
    draft.key = props.source?.key ?? ''
    await nextTick()
    nameInput.value?.focus()
  },
)

function submit(): void {
  emit('submit', {
    label: draft.label.trim(),
    kind: draft.kind,
    api: draft.api.trim(),
    key: draft.kind === 'curseforge' ? draft.key.trim() : '',
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
        aria-labelledby="mod-source-dialog-title"
        @submit.prevent="submit"
      >
        <h2 id="mod-source-dialog-title" class="source-dialog__title">
          {{ source ? '编辑 Mod 下载源' : '添加 Mod 下载源' }}
        </h2>

        <div class="source-dialog__fields">
          <label class="source-dialog__field">
            <span class="source-dialog__label">来源</span>
            <select class="mics-select" :value="draft.kind" @change="onKindInput">
              <option v-for="kind in MOD_SOURCE_KINDS" :key="kind" :value="kind">
                {{ MOD_SOURCE_LABELS[kind] }}
              </option>
            </select>
          </label>

          <label class="source-dialog__field">
            <span class="source-dialog__label">名称</span>
            <input
              ref="nameInput"
              v-model="draft.label"
              class="mics-input"
              :placeholder="MOD_SOURCE_LABELS[draft.kind]"
              autocomplete="off"
            />
          </label>

          <label class="source-dialog__field">
            <span class="source-dialog__label">接口地址</span>
            <input
              v-model="draft.api"
              class="mics-input mics-mono"
              :placeholder="apiPlaceholder"
              spellcheck="false"
              autocomplete="off"
            />
          </label>

          <label v-if="draft.kind === 'curseforge'" class="source-dialog__field">
            <span class="source-dialog__label">API Key</span>
            <input
              v-model="draft.key"
              class="mics-input mics-mono"
              type="password"
              placeholder="CurseForge 官方接口需要"
              spellcheck="false"
              autocomplete="off"
            />
          </label>

          <p v-if="draft.kind === 'curseforge'" class="source-dialog__hint">
            官方 Key 需向 CurseForge 申请，请按密码保管，不要提交到仓库或分享给他人。
          </p>
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

.source-dialog__field .mics-input,
.source-dialog__field .mics-select {
  width: 100%;
}

.source-dialog__hint {
  margin: 0;
  color: var(--mics-fg-muted);
  font-size: 11px;
  line-height: 1.6;
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
