<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
  normalizeDownloadSources,
} from '@mics/sdk'
import type { DownloadSource } from '@mics/sdk'
import { ToggleSwitch } from '@mics/ui'
import SourceEditorDialog from './SourceEditorDialog.vue'

const ctx = usePluginContext()
const loading = ref(true)
const concurrency = ref(DEFAULT_DOWNLOAD_CONCURRENCY)
const cacheLimit = ref(DEFAULT_DOWNLOAD_CACHE_LIMIT)
const sources = ref<DownloadSource[]>(DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source })))
const saved = ref(true)
const dragIndex = ref(-1)
const overIndex = ref(-1)
const editorOpen = ref(false)
const editorIndex = ref<number | null>(null)
const sourcesAreDefault = computed(
  () => JSON.stringify(sources.value) === JSON.stringify(DEFAULT_DOWNLOAD_SOURCES),
)
const editorSource = computed<DownloadSource | null>(() => {
  if (editorIndex.value === null) return null
  return sources.value[editorIndex.value] ?? null
})

let concurrencyTimer: ReturnType<typeof setTimeout> | null = null

const displayName = (index: number): string =>
  sources.value[index]?.label.trim() || `源 ${index + 1}`

function markDirty(): void {
  saved.value = false
}

function normalizeConcurrency(value: string): string {
  const fallback = Number(DEFAULT_DOWNLOAD_CONCURRENCY) || 64
  const parsed = Number(value)
  const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  return String(Math.max(1, Math.min(128, Math.round(amount))))
}

async function loadSettings(): Promise<void> {
  loading.value = true
  try {
    const settings = await ctx.ipc.invoke<{
      concurrency: string
      cacheLimit: string
      sources: DownloadSource[]
    }>('mics.download.manager', 'settings/get')
    concurrency.value = settings.concurrency
    cacheLimit.value = settings.cacheLimit
    sources.value = normalizeDownloadSources(settings.sources)
    saved.value = true
  } finally {
    loading.value = false
  }
}

async function saveSources(): Promise<void> {
  const normalized = sources.value.map((source, index) => ({
    label: source.label.trim() || displayName(index),
    launchermeta: source.launchermeta.trim(),
    libraries: source.libraries.trim(),
    resources: source.resources.trim(),
    enabled: source.enabled !== false,
  }))
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'sources',
    value: JSON.stringify(normalized),
  })
  sources.value = normalized
  saved.value = true
}

function persistConcurrency(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'concurrency',
    value: concurrency.value,
  })
}

function saveConcurrency(): void {
  if (concurrencyTimer) {
    clearTimeout(concurrencyTimer)
    concurrencyTimer = null
  }
  concurrency.value = normalizeConcurrency(concurrency.value)
  persistConcurrency()
}

function queueConcurrencySave(): void {
  if (concurrencyTimer) clearTimeout(concurrencyTimer)
  concurrencyTimer = setTimeout(() => {
    concurrencyTimer = null
    persistConcurrency()
  }, 500)
}

function resetConcurrency(): void {
  concurrency.value = DEFAULT_DOWNLOAD_CONCURRENCY
  saveConcurrency()
}

function saveCacheLimit(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'cacheLimit',
    value: cacheLimit.value,
  })
}

function resetCacheLimit(): void {
  cacheLimit.value = DEFAULT_DOWNLOAD_CACHE_LIMIT
  saveCacheLimit()
}

async function resetSources(): Promise<void> {
  sources.value = DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source }))
  await saveSources()
}

function resetDrag(): void {
  dragIndex.value = -1
  overIndex.value = -1
}

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index
  overIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(index: number, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  overIndex.value = index
}

function onDrop(index: number): void {
  const from = dragIndex.value
  resetDrag()
  if (from < 0 || from === index) return
  const list = [...sources.value]
  const [item] = list.splice(from, 1)
  if (!item) return
  list.splice(index, 0, item)
  sources.value = list
  markDirty()
}

function openEditor(index: number | null): void {
  editorIndex.value = index
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editorIndex.value = null
}

function applyEditor(source: DownloadSource): void {
  const index = editorIndex.value
  if (index === null) sources.value.push(source)
  else sources.value[index] = source
  closeEditor()
  markDirty()
}

function setSourceEnabled(index: number, enabled: boolean): void {
  const source = sources.value[index]
  if (!source) return
  source.enabled = enabled
  markDirty()
}

function removeSource(index: number): void {
  sources.value.splice(index, 1)
  markDirty()
}

onMounted(loadSettings)

onUnmounted(() => {
  if (concurrencyTimer) {
    clearTimeout(concurrencyTimer)
    concurrencyTimer = null
    persistConcurrency()
  }
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">下载设置</h1>
    </header>

    <div v-if="loading" class="mics-empty">正在读取设置…</div>

    <template v-else>
      <section class="mics-section">
        <h2 class="mics-section__title">下载行为</h2>
        <div class="mics-form">
          <div class="mics-field">
            <div>
              <div class="mics-field__label">最大并发</div>
              <div class="mics-field__hint">同时下载的文件数（1–128）</div>
            </div>
            <div class="mics-field__control">
              <input
                v-model="concurrency"
                class="mics-input"
                inputmode="numeric"
                @input="queueConcurrencySave"
                @change="saveConcurrency"
              />
              <button
                class="mics-button mics-button--ghost mics-button--small"
                title="恢复默认值"
                :disabled="concurrency === DEFAULT_DOWNLOAD_CONCURRENCY"
                @click="resetConcurrency"
              >
                重置
              </button>
            </div>
          </div>

          <div class="mics-field">
            <div class="mics-field__label">缓存上限</div>
            <div class="mics-field__control">
              <select v-model="cacheLimit" class="mics-select" @change="saveCacheLimit">
                <option value="2">2 GB</option>
                <option value="5">5 GB</option>
                <option value="10">10 GB</option>
                <option value="0">不限制</option>
              </select>
              <button
                class="mics-button mics-button--ghost mics-button--small"
                title="恢复默认值"
                :disabled="cacheLimit === DEFAULT_DOWNLOAD_CACHE_LIMIT"
                @click="resetCacheLimit"
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="mics-section">
        <div class="settings-sources__head">
          <div class="settings-sources__heading">
            <h2 class="mics-section__title">下载源</h2>
            <span class="settings-sources__note">自上而下优先级递减</span>
          </div>
          <div class="settings-sources__actions">
            <button class="mics-button mics-button--ghost mics-button--small" @click="openEditor(null)">
              添加源
            </button>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              title="恢复默认值"
              :disabled="sourcesAreDefault"
              @click="resetSources"
            >
              重置
            </button>
            <button
              class="mics-button mics-button--small"
              :class="saved ? 'mics-button--ghost' : 'mics-button--primary'"
              :disabled="saved"
              @click="saveSources"
            >
              {{ saved ? '已保存' : '保存' }}
            </button>
          </div>
        </div>

        <div class="mics-list">
          <div v-if="sources.length === 0" class="mics-empty">尚未配置下载源</div>

          <div
            v-for="(src, index) in sources"
            :key="index"
            class="settings-source"
            :class="{
              'settings-source--dragging': index === dragIndex,
              'settings-source--over': index === overIndex && index !== dragIndex,
              'settings-source--disabled': !src.enabled,
            }"
            @dragover="onDragOver(index, $event)"
            @drop="onDrop(index)"
          >
            <button
              class="settings-source__handle"
              type="button"
              title="拖拽排序"
              aria-label="拖拽排序"
              draggable="true"
              @dragstart="onDragStart(index, $event)"
              @dragend="resetDrag"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <line x1="8" y1="6" x2="16" y2="6" />
                <line x1="8" y1="12" x2="16" y2="12" />
                <line x1="8" y1="18" x2="16" y2="18" />
              </svg>
            </button>

            <span class="settings-source__name" :title="displayName(index)">
              {{ displayName(index) }}
            </span>
            <span v-if="!src.enabled" class="settings-source__state">已禁用</span>

            <div class="settings-source__actions">
              <button
                class="settings-source__action"
                type="button"
                title="编辑"
                aria-label="编辑"
                @click="openEditor(index)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>

              <button
                class="settings-source__action settings-source__action--danger"
                type="button"
                title="删除"
                aria-label="删除"
                @click="removeSource(index)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                </svg>
              </button>

              <ToggleSwitch
                :model-value="src.enabled"
                :label="`${displayName(index)}：${src.enabled ? '已启用' : '已禁用'}`"
                title="关闭后跳过该下载源"
                @update:model-value="setSourceEnabled(index, $event)"
              />
            </div>
          </div>
        </div>
      </section>

      <SourceEditorDialog
        :open="editorOpen"
        :source="editorSource"
        @submit="applyEditor"
        @cancel="closeEditor"
      />
    </template>
  </div>
</template>

<style scoped>
.settings-sources__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-sources__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.settings-sources__note {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.settings-sources__actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.settings-source {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--mics-border);
  transition: box-shadow .12s ease, opacity .12s ease;
}

.settings-source:last-child {
  border-bottom: 0;
}

.settings-source--dragging {
  opacity: .45;
}

.settings-source--over {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mics-accent) 55%, transparent);
}

.settings-source__handle,
.settings-source__action {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  background: transparent;
  color: var(--mics-fg-muted);
  transition: border-color .12s ease, background .12s ease, color .12s ease;
}

.settings-source__handle {
  cursor: grab;
}

.settings-source__handle:active {
  cursor: grabbing;
}

.settings-source__handle:hover,
.settings-source__action:hover {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.settings-source__handle:focus-visible,
.settings-source__action:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.settings-source__action--danger:hover {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, transparent);
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.settings-source__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--mics-fg);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-source--disabled .settings-source__name {
  color: var(--mics-fg-muted);
}

.settings-source__state {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.settings-source__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
