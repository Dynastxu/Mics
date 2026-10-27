<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SOURCES,
} from '@mics/sdk'
import type { DownloadSource } from '@mics/sdk'

const TARGET_FIELDS = [
  { key: 'launchermeta', label: '版本清单', placeholder: 'launchermeta.mojang.com' },
  { key: 'libraries', label: '依赖库', placeholder: 'libraries.minecraft.net' },
  { key: 'resources', label: '资源文件', placeholder: 'resources.download.minecraft.net' },
] as const satisfies ReadonlyArray<{
  key: keyof DownloadSource
  label: string
  placeholder: string
}>

const ctx = usePluginContext()
const loading = ref(true)
const concurrency = ref(DEFAULT_DOWNLOAD_CONCURRENCY)
const cacheLimit = ref(DEFAULT_DOWNLOAD_CACHE_LIMIT)
const sources = ref<DownloadSource[]>(DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source })))
const saved = ref(true)
const dragIndex = ref(-1)
const overIndex = ref(-1)
const sourcesAreDefault = computed(
  () => JSON.stringify(sources.value) === JSON.stringify(DEFAULT_DOWNLOAD_SOURCES),
)

let concurrencyTimer: ReturnType<typeof setTimeout> | null = null

const pendingLabel = (index: number) =>
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
    sources.value = settings.sources?.length
      ? settings.sources
      : DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source }))
    saved.value = true
  } finally {
    loading.value = false
  }
}

async function saveSources(): Promise<void> {
  const normalized = sources.value.map((source, index) => ({
    label: source.label.trim() || pendingLabel(index),
    launchermeta: source.launchermeta.trim(),
    libraries: source.libraries.trim(),
    resources: source.resources.trim(),
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

function addSource(): void {
  sources.value.push({ label: '', launchermeta: '', libraries: '', resources: '' })
  markDirty()
}

function removeSource(index: number): void {
  sources.value.splice(index, 1)
  markDirty()
}

function updateSourceField(index: number, field: keyof DownloadSource, value: string): void {
  const source = sources.value[index]
  if (!source) return
  source[field] = value
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
            <button class="mics-button mics-button--ghost mics-button--small" @click="addSource">
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
            }"
            @dragover="onDragOver(index, $event)"
            @drop="onDrop(index)"
          >
            <div class="settings-source__head">
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

              <input
                class="mics-input settings-source__name"
                :value="src.label"
                :placeholder="pendingLabel(index)"
                aria-label="源名称"
                @input="updateSourceField(index, 'label', ($event.target as HTMLInputElement).value)"
              />

              <button
                class="settings-source__remove"
                type="button"
                title="移除"
                aria-label="移除"
                @click="removeSource(index)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div class="settings-source__targets">
              <label
                v-for="field in TARGET_FIELDS"
                :key="field.key"
                class="settings-target"
              >
                <span class="settings-target__label">{{ field.label }}</span>
                <input
                  class="mics-input mics-mono settings-target__input"
                  :value="src[field.key]"
                  :placeholder="field.placeholder"
                  spellcheck="false"
                  autocomplete="off"
                  @input="updateSourceField(index, field.key, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
          </div>
        </div>
      </section>
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
  flex-direction: column;
  gap: 10px;
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

.settings-source__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-source__handle,
.settings-source__remove {
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
.settings-source__remove:hover {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.settings-source__handle:focus-visible,
.settings-source__remove:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.settings-source__remove:hover {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, transparent);
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.settings-source__name {
  flex: 1;
  min-width: 0;
}

.settings-source__targets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 40px;
}

.settings-target {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.settings-target__label {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.settings-target__input {
  width: 100%;
}

/* 窄窗口：缩进让给输入框 */
@media (max-width: 900px) {
  .settings-source__targets {
    padding-left: 0;
  }

  .settings-target {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
    align-items: start;
  }
}
</style>
