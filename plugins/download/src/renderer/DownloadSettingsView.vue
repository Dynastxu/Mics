<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SEGMENTS,
  DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD,
  DEFAULT_DOWNLOAD_SOURCES,
  DEFAULT_LOADER_SOURCES,
  DEFAULT_MOD_SOURCES,
  DOWNLOAD_SEGMENT_OPTIONS,
  DOWNLOAD_SEGMENT_THRESHOLD_OPTIONS,
  LOADER_LABELS,
  MOD_SOURCE_LABELS,
  modSourceNeedsKey,
  normalizeDownloadSources,
  normalizeLoaderSources,
  normalizeModSources,
} from '@mics/sdk'
import type { DownloadSource, LoaderSource, ModSource } from '@mics/sdk'
import { ToggleSwitch } from '@mics/ui'
import SourceEditorDialog from './SourceEditorDialog.vue'
import LoaderSourceDialog from './LoaderSourceDialog.vue'
import ModSourceDialog from './ModSourceDialog.vue'

const ctx = usePluginContext()
const loading = ref(true)
const concurrency = ref(DEFAULT_DOWNLOAD_CONCURRENCY)
const segments = ref(DEFAULT_DOWNLOAD_SEGMENTS)
const segmentThreshold = ref(DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD)
const cacheLimit = ref(DEFAULT_DOWNLOAD_CACHE_LIMIT)
const cacheBytes = ref(0)
const cacheFiles = ref(0)
const cacheLoading = ref(false)
const cacheClearing = ref(false)
const cacheError = ref('')
const confirmClear = ref(false)
const sources = ref<DownloadSource[]>(DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source })))
const loaderSources = ref<LoaderSource[]>(
  DEFAULT_LOADER_SOURCES.map((source) => ({ ...source })),
)
const modSources = ref<ModSource[]>(DEFAULT_MOD_SOURCES.map((source) => ({ ...source })))
const saved = ref(true)
const loaderSaved = ref(true)
const modSaved = ref(true)
const dragIndex = ref(-1)
const overIndex = ref(-1)
const loaderDragIndex = ref(-1)
const loaderOverIndex = ref(-1)
const modDragIndex = ref(-1)
const modOverIndex = ref(-1)
const editorOpen = ref(false)
const editorIndex = ref<number | null>(null)
const loaderEditorOpen = ref(false)
const loaderEditorIndex = ref<number | null>(null)
const modEditorOpen = ref(false)
const modEditorIndex = ref<number | null>(null)
const sourcesAreDefault = computed(
  () => JSON.stringify(sources.value) === JSON.stringify(DEFAULT_DOWNLOAD_SOURCES),
)
const loaderSourcesAreDefault = computed(
  () => JSON.stringify(loaderSources.value) === JSON.stringify(DEFAULT_LOADER_SOURCES),
)
const modSourcesAreDefault = computed(
  () => JSON.stringify(modSources.value) === JSON.stringify(DEFAULT_MOD_SOURCES),
)
const editorSource = computed<DownloadSource | null>(() => {
  if (editorIndex.value === null) return null
  return sources.value[editorIndex.value] ?? null
})
const loaderEditorSource = computed<LoaderSource | null>(() => {
  if (loaderEditorIndex.value === null) return null
  return loaderSources.value[loaderEditorIndex.value] ?? null
})
const modEditorSource = computed<ModSource | null>(() => {
  if (modEditorIndex.value === null) return null
  return modSources.value[modEditorIndex.value] ?? null
})

let concurrencyTimer: ReturnType<typeof setTimeout> | null = null

const displayName = (index: number): string =>
  sources.value[index]?.label.trim() || `源 ${index + 1}`

const loaderDisplayName = (index: number): string => {
  const source = loaderSources.value[index]
  if (!source) return `加载器源 ${index + 1}`
  return source.label.trim() || `${LOADER_LABELS[source.kind]} 源 ${index + 1}`
}

const modDisplayName = (index: number): string => {
  const source = modSources.value[index]
  if (!source) return `Mod 源 ${index + 1}`
  return source.label.trim() || `${MOD_SOURCE_LABELS[source.kind]} 源 ${index + 1}`
}



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
      segments: string
      segmentThreshold: string
      cacheLimit: string
      sources: DownloadSource[]
      loaderSources: LoaderSource[]
      modSources: ModSource[]
    }>('mics.download.manager', 'settings/get')
    concurrency.value = settings.concurrency
    segments.value = settings.segments || DEFAULT_DOWNLOAD_SEGMENTS
    segmentThreshold.value = settings.segmentThreshold || DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD
    cacheLimit.value = settings.cacheLimit
    sources.value = normalizeDownloadSources(settings.sources)
    loaderSources.value = normalizeLoaderSources(settings.loaderSources)
    modSources.value = normalizeModSources(settings.modSources)
    saved.value = true
    loaderSaved.value = true
    modSaved.value = true
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

function saveSegments(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'segments',
    value: segments.value,
  })
}

function resetSegments(): void {
  segments.value = DEFAULT_DOWNLOAD_SEGMENTS
  saveSegments()
}

function saveSegmentThreshold(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'segmentThreshold',
    value: segmentThreshold.value,
  })
}

function resetSegmentThreshold(): void {
  segmentThreshold.value = DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD
  saveSegmentThreshold()
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

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function loadCacheStats(): Promise<void> {
  cacheLoading.value = true
  try {
    const usage = await ctx.ipc.invoke<{ bytes: number; files: number }>(
      'mics.download.manager',
      'cache/stats',
    )
    cacheBytes.value = usage.bytes
    cacheFiles.value = usage.files
    cacheError.value = ''
  } catch (cause) {
    cacheError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    cacheLoading.value = false
  }
}

let confirmClearTimer: ReturnType<typeof setTimeout> | null = null

function resetConfirmClear(): void {
  if (confirmClearTimer) {
    clearTimeout(confirmClearTimer)
    confirmClearTimer = null
  }
  confirmClear.value = false
}

/** 清空缓存不可撤销，先切成「确认清空」再执行 */
function requestClearCache(): void {
  if (!confirmClear.value) {
    confirmClear.value = true
    if (confirmClearTimer) clearTimeout(confirmClearTimer)
    confirmClearTimer = setTimeout(() => {
      confirmClearTimer = null
      confirmClear.value = false
    }, 4000)
    return
  }
  void clearCache()
}

async function clearCache(): Promise<void> {
  resetConfirmClear()
  cacheClearing.value = true
  try {
    const usage = await ctx.ipc.invoke<{ bytes: number; files: number }>(
      'mics.download.manager',
      'cache/clear',
    )
    cacheBytes.value = usage.bytes
    cacheFiles.value = usage.files
    cacheError.value = ''
  } catch (cause) {
    cacheError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    cacheClearing.value = false
  }
}

async function resetSources(): Promise<void> {
  sources.value = DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source }))
  await saveSources()
}

async function saveLoaderSources(): Promise<void> {
  const normalized = loaderSources.value.map((source, index) => {
    const official = DEFAULT_LOADER_SOURCES.find((item) => item.kind === source.kind)
    return {
      label: source.label.trim() || loaderDisplayName(index),
      kind: source.kind,
      // 留空表示使用官方地址；与主进程的归一化保持一致
      meta: source.meta.trim() || official?.meta || '',
      maven: source.maven.trim() || official?.maven || '',
      enabled: source.enabled !== false,
    }
  })
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'loaderSources',
    value: JSON.stringify(normalized),
  })
  loaderSources.value = normalized
  loaderSaved.value = true
}

async function resetLoaderSources(): Promise<void> {
  loaderSources.value = DEFAULT_LOADER_SOURCES.map((source) => ({ ...source }))
  await saveLoaderSources()
}

function markLoaderDirty(): void {
  loaderSaved.value = false
}

function resetLoaderDrag(): void {
  loaderDragIndex.value = -1
  loaderOverIndex.value = -1
}

function onLoaderDragStart(index: number, event: DragEvent): void {
  loaderDragIndex.value = index
  loaderOverIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onLoaderDragOver(index: number, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  loaderOverIndex.value = index
}

function onLoaderDrop(index: number): void {
  const from = loaderDragIndex.value
  resetLoaderDrag()
  if (from < 0 || from === index) return
  const list = [...loaderSources.value]
  const [item] = list.splice(from, 1)
  if (!item) return
  list.splice(index, 0, item)
  loaderSources.value = list
  markLoaderDirty()
}

function openLoaderEditor(index: number | null): void {
  loaderEditorIndex.value = index
  loaderEditorOpen.value = true
}

function closeLoaderEditor(): void {
  loaderEditorOpen.value = false
  loaderEditorIndex.value = null
}

function applyLoaderEditor(source: LoaderSource): void {
  const index = loaderEditorIndex.value
  if (index === null) loaderSources.value.push(source)
  else loaderSources.value[index] = source
  closeLoaderEditor()
  markLoaderDirty()
}

function setLoaderSourceEnabled(index: number, enabled: boolean): void {
  const source = loaderSources.value[index]
  if (!source) return
  source.enabled = enabled
  markLoaderDirty()
}

function removeLoaderSource(index: number): void {
  loaderSources.value.splice(index, 1)
  markLoaderDirty()
}

async function saveModSources(): Promise<void> {
  const normalized = modSources.value.map((source, index) => {
    const official = DEFAULT_MOD_SOURCES.find((item) => item.kind === source.kind)
    return {
      label: source.label.trim() || modDisplayName(index),
      kind: source.kind,
      // 留空表示使用官方地址；与主进程的归一化保持一致
      api: source.api.trim() || official?.api || '',
      key: source.key.trim(),
      enabled: source.enabled !== false,
    }
  })
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'modSources',
    value: JSON.stringify(normalized),
  })
  modSources.value = normalized
  modSaved.value = true
}

async function resetModSources(): Promise<void> {
  modSources.value = DEFAULT_MOD_SOURCES.map((source) => ({ ...source }))
  await saveModSources()
}

function markModDirty(): void {
  modSaved.value = false
}

function resetModDrag(): void {
  modDragIndex.value = -1
  modOverIndex.value = -1
}

function onModDragStart(index: number, event: DragEvent): void {
  modDragIndex.value = index
  modOverIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onModDragOver(index: number, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  modOverIndex.value = index
}

function onModDrop(index: number): void {
  const from = modDragIndex.value
  resetModDrag()
  if (from < 0 || from === index) return
  const list = [...modSources.value]
  const [item] = list.splice(from, 1)
  if (!item) return
  list.splice(index, 0, item)
  modSources.value = list
  markModDirty()
}

function openModEditor(index: number | null): void {
  modEditorIndex.value = index
  modEditorOpen.value = true
}

function closeModEditor(): void {
  modEditorOpen.value = false
  modEditorIndex.value = null
}

function applyModEditor(source: ModSource): void {
  const index = modEditorIndex.value
  if (index === null) modSources.value.push(source)
  else modSources.value[index] = source
  closeModEditor()
  markModDirty()
}

function setModSourceEnabled(index: number, enabled: boolean): void {
  const source = modSources.value[index]
  if (!source) return
  source.enabled = enabled
  markModDirty()
}

function removeModSource(index: number): void {
  modSources.value.splice(index, 1)
  markModDirty()
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

onMounted(() => {
  void loadSettings()
  void loadCacheStats()
})

onUnmounted(() => {
  if (concurrencyTimer) {
    clearTimeout(concurrencyTimer)
    concurrencyTimer = null
    persistConcurrency()
  }
  if (confirmClearTimer) {
    clearTimeout(confirmClearTimer)
    confirmClearTimer = null
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
            <div>
              <div class="mics-field__label">大文件分段</div>
              <div class="mics-field__hint">
                达到分段阈值且服务端支持 Range 时，单文件使用多连接；自动 = 4 连接
              </div>
            </div>
            <div class="mics-field__control">
              <select v-model="segments" class="mics-select" @change="saveSegments">
                <option
                  v-for="option in DOWNLOAD_SEGMENT_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="mics-button mics-button--ghost mics-button--small"
                title="恢复默认值"
                :disabled="segments === DEFAULT_DOWNLOAD_SEGMENTS"
                @click="resetSegments"
              >
                重置
              </button>
            </div>
          </div>

          <div class="mics-field">
            <div>
              <div class="mics-field__label">分段阈值</div>
              <div class="mics-field__hint">只有达到该大小的文件才启用多连接</div>
            </div>
            <div class="mics-field__control">
              <select
                v-model="segmentThreshold"
                class="mics-select"
                @change="saveSegmentThreshold"
              >
                <option
                  v-for="option in DOWNLOAD_SEGMENT_THRESHOLD_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <button
                class="mics-button mics-button--ghost mics-button--small"
                title="恢复默认值"
                :disabled="segmentThreshold === DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD"
                @click="resetSegmentThreshold"
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

          <div class="mics-field">
            <div>
              <div class="mics-field__label">已用缓存</div>
              <div class="mics-field__hint">重装或安装到其它实例时，缓存里的文件会直接复用</div>
            </div>
            <div class="mics-field__control">
              <span class="settings-cache">
                {{ cacheLoading ? '统计中…' : `${fmtBytes(cacheBytes)} · ${cacheFiles} 个文件` }}
              </span>
              <button
                class="mics-button mics-button--small"
                :class="confirmClear ? 'mics-button--danger' : 'mics-button--ghost'"
                :disabled="cacheClearing || cacheLoading || (cacheBytes === 0 && !confirmClear)"
                @click="requestClearCache"
              >
                {{ confirmClear ? '确认清空' : '清空' }}
              </button>
            </div>
          </div>
        </div>

        <p v-if="cacheError" class="mics-notice">{{ cacheError }}</p>
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

      <section class="mics-section">
        <div class="settings-sources__head">
          <div class="settings-sources__heading">
            <h2 class="mics-section__title">模组加载器下载源</h2>
            <span class="settings-sources__note">自上而下优先级递减</span>
          </div>
          <div class="settings-sources__actions">
            <button
              class="mics-button mics-button--ghost mics-button--small"
              @click="openLoaderEditor(null)"
            >
              添加源
            </button>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              title="恢复默认值"
              :disabled="loaderSourcesAreDefault"
              @click="resetLoaderSources"
            >
              重置
            </button>
            <button
              class="mics-button mics-button--small"
              :class="loaderSaved ? 'mics-button--ghost' : 'mics-button--primary'"
              :disabled="loaderSaved"
              @click="saveLoaderSources"
            >
              {{ loaderSaved ? '已保存' : '保存' }}
            </button>
          </div>
        </div>

        <div class="mics-list">
          <div v-if="loaderSources.length === 0" class="mics-empty">尚未配置加载器下载源</div>

          <div
            v-for="(src, index) in loaderSources"
            :key="index"
            class="settings-source"
            :class="{
              'settings-source--dragging': index === loaderDragIndex,
              'settings-source--over': index === loaderOverIndex && index !== loaderDragIndex,
              'settings-source--disabled': !src.enabled,
            }"
            @dragover="onLoaderDragOver(index, $event)"
            @drop="onLoaderDrop(index)"
          >
            <button
              class="settings-source__handle"
              type="button"
              title="拖拽排序"
              aria-label="拖拽排序"
              draggable="true"
              @dragstart="onLoaderDragStart(index, $event)"
              @dragend="resetLoaderDrag"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <line x1="8" y1="6" x2="16" y2="6" />
                <line x1="8" y1="12" x2="16" y2="12" />
                <line x1="8" y1="18" x2="16" y2="18" />
              </svg>
            </button>

            <span class="mics-badge">{{ LOADER_LABELS[src.kind] }}</span>
            <span class="settings-source__name" :title="loaderDisplayName(index)">
              {{ loaderDisplayName(index) }}
            </span>
            <span v-if="!src.enabled" class="settings-source__state">已禁用</span>

            <div class="settings-source__actions">
              <button
                class="settings-source__action"
                type="button"
                title="编辑"
                aria-label="编辑"
                @click="openLoaderEditor(index)"
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
                @click="removeLoaderSource(index)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                </svg>
              </button>

              <ToggleSwitch
                :model-value="src.enabled"
                :label="`${loaderDisplayName(index)}：${src.enabled ? '已启用' : '已禁用'}`"
                title="关闭后跳过该下载源"
                @update:model-value="setLoaderSourceEnabled(index, $event)"
              />
            </div>
          </div>
        </div>
      </section>

      <section class="mics-section">
        <div class="settings-sources__head">
          <div class="settings-sources__heading">
            <h2 class="mics-section__title">Mod 下载源</h2>
            <span class="settings-sources__note">可添加镜像；CurseForge 需要 API Key</span>
          </div>
          <div class="settings-sources__actions">
            <button class="mics-button mics-button--ghost mics-button--small" @click="openModEditor(null)">
              添加源
            </button>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              title="恢复默认值"
              :disabled="modSourcesAreDefault"
              @click="resetModSources"
            >
              重置
            </button>
            <button
              class="mics-button mics-button--small"
              :class="modSaved ? 'mics-button--ghost' : 'mics-button--primary'"
              :disabled="modSaved"
              @click="saveModSources"
            >
              {{ modSaved ? '已保存' : '保存' }}
            </button>
          </div>
        </div>

        <div class="mics-list">
          <div v-if="modSources.length === 0" class="mics-empty">尚未配置 Mod 下载源</div>

          <div
            v-for="(src, index) in modSources"
            :key="index"
            class="settings-source"
            :class="{
              'settings-source--dragging': index === modDragIndex,
              'settings-source--over': index === modOverIndex && index !== modDragIndex,
              'settings-source--disabled': !src.enabled,
            }"
            @dragover="onModDragOver(index, $event)"
            @drop="onModDrop(index)"
          >
            <button
              class="settings-source__handle"
              type="button"
              title="拖拽排序"
              aria-label="拖拽排序"
              draggable="true"
              @dragstart="onModDragStart(index, $event)"
              @dragend="resetModDrag"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <line x1="8" y1="6" x2="16" y2="6" />
                <line x1="8" y1="12" x2="16" y2="12" />
                <line x1="8" y1="18" x2="16" y2="18" />
              </svg>
            </button>

            <span class="mics-badge">{{ MOD_SOURCE_LABELS[src.kind] }}</span>
            <span class="settings-source__name" :title="modDisplayName(index)">
              {{ modDisplayName(index) }}
            </span>
            <span v-if="!src.enabled" class="settings-source__state">已禁用</span>
            <span
              v-else-if="modSourceNeedsKey(src) && !src.key.trim()"
              class="settings-source__state"
            >
              缺少 API Key
            </span>

            <div class="settings-source__actions">
              <button
                class="settings-source__action"
                type="button"
                title="编辑"
                aria-label="编辑"
                @click="openModEditor(index)"
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
                @click="removeModSource(index)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                </svg>
              </button>

              <ToggleSwitch
                :model-value="src.enabled"
                :label="`${modDisplayName(index)}：${src.enabled ? '已启用' : '已禁用'}`"
                title="关闭后跳过该来源"
                @update:model-value="setModSourceEnabled(index, $event)"
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

      <LoaderSourceDialog
        :open="loaderEditorOpen"
        :source="loaderEditorSource"
        @submit="applyLoaderEditor"
        @cancel="closeLoaderEditor"
      />

      <ModSourceDialog
        :open="modEditorOpen"
        :source="modEditorSource"
        @submit="applyModEditor"
        @cancel="closeModEditor"
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

.settings-cache {
  color: var(--mics-fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mics-notice {
  margin-top: 10px;
}
</style>
