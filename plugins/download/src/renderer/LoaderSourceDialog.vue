<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { DEFAULT_LOADER_SOURCES, LOADER_LABELS, LOADER_SOURCE_KINDS } from '@mics/sdk'
import type { LoaderSource, LoaderSourceKind } from '@mics/sdk'

const props = defineProps<{
  open: boolean
  /** 传入现有条目表示编辑；null 表示新建 */
  source: LoaderSource | null
}>()

const emit = defineEmits<{
  submit: [source: LoaderSource]
  cancel: []
}>()

const draft = reactive<{
  label: string
  kind: LoaderSourceKind
  meta: string
  maven: string
}>({
  label: '',
  kind: 'fabric',
  meta: '',
  maven: '',
})

const nameInput = ref<HTMLInputElement | null>(null)

const officialOf = (kind: LoaderSourceKind): LoaderSource | undefined =>
  DEFAULT_LOADER_SOURCES.find((source) => source.kind === kind)

const metaPlaceholder = computed(() => officialOf(draft.kind)?.meta ?? 'meta.fabricmc.net')
const mavenPlaceholder = computed(() => officialOf(draft.kind)?.maven ?? 'maven.fabricmc.net')

/** 切换加载器类型时，把仍停留在旧官方地址的输入换成新类型的官方地址 */
function onKindInput(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as LoaderSourceKind
  const previous = officialOf(draft.kind)
  if (previous && draft.meta === previous.meta) draft.meta = ''
  if (previous && draft.maven === previous.maven) draft.maven = ''
  draft.kind = next
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    draft.label = props.source?.label ?? ''
    draft.kind = props.source?.kind ?? 'fabric'
    draft.meta = props.source?.meta ?? ''
    draft.maven = props.source?.maven ?? ''
    await nextTick()
    nameInput.value?.focus()
  },
)

function submit(): void {
  emit('submit', {
    label: draft.label.trim(),
    kind: draft.kind,
    meta: draft.meta.trim(),
    maven: draft.maven.trim(),
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
        aria-labelledby="loader-source-dialog-title"
        @submit.prevent="submit"
      >
        <h2 id="loader-source-dialog-title" class="source-dialog__title">
          {{ source ? '编辑加载器下载源' : '添加加载器下载源' }}
        </h2>

        <div class="source-dialog__fields">
          <label class="source-dialog__field">
            <span class="source-dialog__label">加载器</span>
            <select
              class="mics-select"
              :value="draft.kind"
              @change="onKindInput"
            >
              <option v-for="kind in LOADER_SOURCE_KINDS" :key="kind" :value="kind">
                {{ LOADER_LABELS[kind] }}
              </option>
            </select>
          </label>

          <label class="source-dialog__field">
            <span class="source-dialog__label">名称</span>
            <input
              ref="nameInput"
              v-model="draft.label"
              class="mics-input"
              autocomplete="off"
            />
          </label>

          <label class="source-dialog__field">
            <span class="source-dialog__label">元数据</span>
            <input
              v-model="draft.meta"
              class="mics-input mics-mono"
              :placeholder="metaPlaceholder"
              spellcheck="false"
              autocomplete="off"
            />
          </label>

          <label class="source-dialog__field">
            <span class="source-dialog__label">文件</span>
            <input
              v-model="draft.maven"
              class="mics-input mics-mono"
              :placeholder="mavenPlaceholder"
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

.source-dialog__field .mics-input,
.source-dialog__field .mics-select {
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
