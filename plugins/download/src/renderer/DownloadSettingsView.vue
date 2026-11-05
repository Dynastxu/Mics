<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext, useSettingsExtensions } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsPage, SettingsRow } from '@mics/ui'
import {
  DEFAULT_DOWNLOAD_CACHE_LIMIT,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_SEGMENTS,
  DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD,
  DEFAULT_DOWNLOAD_SOURCES,
  DEFAULT_LOADER_SOURCES,
  DEFAULT_MOD_SOURCES,
  DOWNLOAD_CACHE_LIMIT_OFF,
  DOWNLOAD_CACHE_LIMIT_UNLIMITED,
  LOADER_LABELS,
  MAX_DOWNLOAD_SEGMENTS,
  MIN_DOWNLOAD_SEGMENTS,
  MOD_SOURCE_LABELS,
  modSourceNeedsKey,
  normalizeDownloadCacheLimit,
  normalizeDownloadSegmentThreshold,
  normalizeDownloadSegments,
  normalizeDownloadSources,
  normalizeLoaderSources,
  normalizeModSources,
  parseDownloadCacheLimit
} from '@mics/sdk'
import type { DownloadCacheLimitMode, DownloadSource, LoaderSource, ModSource } from '@mics/sdk'
import SourceEditorDialog from './SourceEditorDialog.vue'
import LoaderSourceDialog from './LoaderSourceDialog.vue'
import ModSourceDialog from './ModSourceDialog.vue'
import SourceList from './SourceList.vue'
import { useSourceDrag } from './useSourceDrag'

const ctx = usePluginContext()
const extensions = useSettingsExtensions('settings.download')
const loading = ref(true)
const concurrency = ref(DEFAULT_DOWNLOAD_CONCURRENCY)
const segments = ref(DEFAULT_DOWNLOAD_SEGMENTS)
const segmentThreshold = ref(DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD)
const cacheLimitMode = ref<DownloadCacheLimitMode>('limit')
const cacheLimitMb = ref(DEFAULT_DOWNLOAD_CACHE_LIMIT)
const cacheBytes = ref(0)
const cacheFiles = ref(0)
const cacheLoading = ref(false)
const cacheClearing = ref(false)
const cacheError = ref('')
const confirmClear = ref(false)
const sources = ref<DownloadSource[]>(DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source })))
const loaderSources = ref<LoaderSource[]>(DEFAULT_LOADER_SOURCES.map((source) => ({ ...source })))
const modSources = ref<ModSource[]>(DEFAULT_MOD_SOURCES.map((source) => ({ ...source })))
const saved = ref(true)
const loaderSaved = ref(true)
const modSaved = ref(true)
const sourceDrag = useSourceDrag()
const loaderDrag = useSourceDrag()
const modDrag = useSourceDrag()
const editorOpen = ref(false)
const editorIndex = ref<number | null>(null)
const loaderEditorOpen = ref(false)
const loaderEditorIndex = ref<number | null>(null)
const modEditorOpen = ref(false)
const modEditorIndex = ref<number | null>(null)
const sourcesAreDefault = computed(
  () => JSON.stringify(sources.value) === JSON.stringify(DEFAULT_DOWNLOAD_SOURCES)
)
const loaderSourcesAreDefault = computed(
  () => JSON.stringify(loaderSources.value) === JSON.stringify(DEFAULT_LOADER_SOURCES)
)
const modSourcesAreDefault = computed(
  () => JSON.stringify(modSources.value) === JSON.stringify(DEFAULT_MOD_SOURCES)
)
const segmentsAreDefault = computed(
  () => normalizeDownloadSegments(segments.value) === DEFAULT_DOWNLOAD_SEGMENTS
)
const segmentThresholdIsDefault = computed(
  () =>
    normalizeDownloadSegmentThreshold(segmentThreshold.value) === DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD
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
let segmentsTimer: ReturnType<typeof setTimeout> | null = null
let segmentThresholdTimer: ReturnType<typeof setTimeout> | null = null
let cacheLimitTimer: ReturnType<typeof setTimeout> | null = null

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
    segments.value = normalizeDownloadSegments(settings.segments)
    segmentThreshold.value = normalizeDownloadSegmentThreshold(settings.segmentThreshold)
    const limit = parseDownloadCacheLimit(settings.cacheLimit)
    cacheLimitMode.value = limit.mode
    if (limit.mode === 'limit') cacheLimitMb.value = String(limit.megabytes)
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
    enabled: source.enabled !== false
  }))
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'sources',
    value: JSON.stringify(normalized)
  })
  sources.value = normalized
  saved.value = true
}

function persistConcurrency(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'concurrency',
    value: concurrency.value
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

function persistSegments(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'segments',
    value: segments.value
  })
}

function saveSegments(): void {
  if (segmentsTimer) {
    clearTimeout(segmentsTimer)
    segmentsTimer = null
  }
  segments.value = normalizeDownloadSegments(segments.value)
  persistSegments()
}

function queueSegmentsSave(): void {
  if (segmentsTimer) clearTimeout(segmentsTimer)
  segmentsTimer = setTimeout(() => {
    segmentsTimer = null
    persistSegments()
  }, 500)
}

function resetSegments(): void {
  segments.value = DEFAULT_DOWNLOAD_SEGMENTS
  saveSegments()
}

function persistSegmentThreshold(): void {
  void ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'segmentThreshold',
    value: segmentThreshold.value
  })
}

function saveSegmentThreshold(): void {
  if (segmentThresholdTimer) {
    clearTimeout(segmentThresholdTimer)
    segmentThresholdTimer = null
  }
  segmentThreshold.value = normalizeDownloadSegmentThreshold(segmentThreshold.value)
  persistSegmentThreshold()
}

function queueSegmentThresholdSave(): void {
  if (segmentThresholdTimer) clearTimeout(segmentThresholdTimer)
  segmentThresholdTimer = setTimeout(() => {
    segmentThresholdTimer = null
    persistSegmentThreshold()
  }, 500)
}

function resetSegmentThreshold(): void {
  segmentThreshold.value = DEFAULT_DOWNLOAD_SEGMENT_THRESHOLD
  saveSegmentThreshold()
}

function cacheLimitValue(): string {
  if (cacheLimitMode.value === 'off') return DOWNLOAD_CACHE_LIMIT_OFF
  if (cacheLimitMode.value === 'unlimited') return DOWNLOAD_CACHE_LIMIT_UNLIMITED
  return normalizeDownloadCacheLimit(cacheLimitMb.value)
}

const cacheLimitIsDefault = computed(() => cacheLimitValue() === DEFAULT_DOWNLOAD_CACHE_LIMIT)

async function persistCacheLimit(): Promise<void> {
  try {
    const usage = await ctx.ipc.invoke<{ bytes: number; files: number } | void>(
      'mics.download.manager',
      'settings/set',
      { key: 'cacheLimit', value: cacheLimitValue() }
    )
    if (usage) {
      cacheBytes.value = usage.bytes
      cacheFiles.value = usage.files
    }
    cacheError.value = ''
  } catch (cause) {
    cacheError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function queueCacheLimitSave(): void {
  if (cacheLimitTimer) clearTimeout(cacheLimitTimer)
  cacheLimitTimer = setTimeout(() => {
    cacheLimitTimer = null
    void persistCacheLimit()
  }, 500)
}

async function saveCacheLimit(): Promise<void> {
  if (cacheLimitTimer) {
    clearTimeout(cacheLimitTimer)
    cacheLimitTimer = null
  }
  if (cacheLimitMode.value === 'limit') {
    cacheLimitMb.value = String(parseDownloadCacheLimit(cacheLimitMb.value).megabytes)
  }
  await persistCacheLimit()
}

function resetCacheLimit(): void {
  cacheLimitMode.value = 'limit'
  cacheLimitMb.value = DEFAULT_DOWNLOAD_CACHE_LIMIT
  void saveCacheLimit()
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
      'cache/stats'
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
      'cache/clear'
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
      enabled: source.enabled !== false
    }
  })
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'loaderSources',
    value: JSON.stringify(normalized)
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
      enabled: source.enabled !== false
    }
  })
  await ctx.ipc.invoke('mics.download.manager', 'settings/set', {
    key: 'modSources',
    value: JSON.stringify(normalized)
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

function onSourceDrop(index: number): void {
  sourceDrag.onDrop(sources, index, markDirty)
}

function onLoaderDrop(index: number): void {
  loaderDrag.onDrop(loaderSources, index, markLoaderDirty)
}

function onModDrop(index: number): void {
  modDrag.onDrop(modSources, index, markModDirty)
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
  if (segmentsTimer) {
    clearTimeout(segmentsTimer)
    segmentsTimer = null
    persistSegments()
  }
  if (segmentThresholdTimer) {
    clearTimeout(segmentThresholdTimer)
    segmentThresholdTimer = null
    persistSegmentThreshold()
  }
  if (cacheLimitTimer) {
    clearTimeout(cacheLimitTimer)
    cacheLimitTimer = null
    void persistCacheLimit()
  }
  if (confirmClearTimer) {
    clearTimeout(confirmClearTimer)
    confirmClearTimer = null
  }
})
</script>

<template>
  <SettingsPage title="下载设置" :loading="loading" :extensions="extensions">
    <SettingsGroup title="下载行为" :error="cacheError">
      <SettingsRow
        label="最大并发"
        hint="同时下载的文件数（1–128）"
        html-for="download-concurrency"
      >
        <input
          id="download-concurrency"
          v-model="concurrency"
          class="mics-input settings-number"
          inputmode="numeric"
          @input="queueConcurrencySave"
          @change="saveConcurrency"
        />
        <template #actions>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            title="恢复默认值"
            :disabled="concurrency === DEFAULT_DOWNLOAD_CONCURRENCY"
            @click="resetConcurrency"
          >
            重置
          </button>
        </template>
      </SettingsRow>

      <SettingsRow label="大文件分段" html-for="download-segments">
        <template #hint>
          达到分段阈值且服务端支持 Range 时，单文件使用的连接数（{{ MIN_DOWNLOAD_SEGMENTS }}–{{
            MAX_DOWNLOAD_SEGMENTS
          }}）
        </template>
        <input
          id="download-segments"
          v-model="segments"
          class="mics-input settings-number"
          inputmode="numeric"
          @input="queueSegmentsSave"
          @change="saveSegments"
        />
        <template #actions>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            title="恢复默认值"
            :disabled="segmentsAreDefault"
            @click="resetSegments"
          >
            重置
          </button>
        </template>
      </SettingsRow>

      <SettingsRow
        label="分段阈值"
        hint="只有达到该大小的文件才启用多连接"
        html-for="download-segment-threshold"
      >
        <input
          id="download-segment-threshold"
          v-model="segmentThreshold"
          class="mics-input settings-number"
          inputmode="numeric"
          @input="queueSegmentThresholdSave"
          @change="saveSegmentThreshold"
        />
        <span class="settings-unit">MB (≥ 1)</span>
        <template #actions>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            title="恢复默认值"
            :disabled="segmentThresholdIsDefault"
            @click="resetSegmentThreshold"
          >
            重置
          </button>
        </template>
      </SettingsRow>

      <SettingsRow
        label="缓存上限"
        hint="超出后清理最旧的文件，不缓存会停用并清空缓存"
        html-for="download-cache-mode"
      >
        <select
          id="download-cache-mode"
          v-model="cacheLimitMode"
          class="mics-select"
          @change="saveCacheLimit"
        >
          <option value="limit">限制大小</option>
          <option value="off">不缓存</option>
          <option value="unlimited">无限制</option>
        </select>
        <template v-if="cacheLimitMode === 'limit'">
          <input
            v-model="cacheLimitMb"
            class="mics-input settings-number"
            :aria-label="'缓存上限（MB）'"
            inputmode="numeric"
            @input="queueCacheLimitSave"
            @change="saveCacheLimit"
          />
          <span class="settings-unit">MB</span>
        </template>
        <template #actions>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            title="恢复默认值"
            :disabled="cacheLimitIsDefault"
            @click="resetCacheLimit"
          >
            重置
          </button>
        </template>
      </SettingsRow>

      <SettingsRow label="已用缓存" hint="重装或安装到其它实例时，缓存里的文件会直接复用">
        <span class="settings-cache">
          {{ cacheLoading ? '统计中…' : `${fmtBytes(cacheBytes)} · ${cacheFiles} 个文件` }}
        </span>
        <template #actions>
          <button
            class="mics-button mics-button--small"
            :class="confirmClear ? 'mics-button--danger' : 'mics-button--ghost'"
            :disabled="cacheClearing || cacheLoading || (cacheBytes === 0 && !confirmClear)"
            @click="requestClearCache"
          >
            {{ confirmClear ? '确认清空' : '清空' }}
          </button>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <SourceList
      :items="sources"
      title="原版下载源"
      note="自上而下优先级递减"
      empty-text="尚未配置下载源"
      :saved="saved"
      :is-default="sourcesAreDefault"
      :drag-index="sourceDrag.dragIndex.value"
      :over-index="sourceDrag.overIndex.value"
      toggle-title="关闭后跳过该下载源"
      :get-display-name="displayName"
      @add="openEditor(null)"
      @reset="resetSources"
      @save="saveSources"
      @edit="openEditor"
      @delete="removeSource"
      @toggle="setSourceEnabled"
      @drag-start="sourceDrag.onDragStart"
      @drag-over="sourceDrag.onDragOver"
      @drag-end="sourceDrag.resetDrag"
      @drop="onSourceDrop"
    />

    <SourceList
      :items="loaderSources"
      title="模组加载器下载源"
      note="自上而下优先级递减"
      empty-text="尚未配置加载器下载源"
      :saved="loaderSaved"
      :is-default="loaderSourcesAreDefault"
      :drag-index="loaderDrag.dragIndex.value"
      :over-index="loaderDrag.overIndex.value"
      toggle-title="关闭后跳过该下载源"
      :get-display-name="loaderDisplayName"
      @add="openLoaderEditor(null)"
      @reset="resetLoaderSources"
      @save="saveLoaderSources"
      @edit="openLoaderEditor"
      @delete="removeLoaderSource"
      @toggle="setLoaderSourceEnabled"
      @drag-start="loaderDrag.onDragStart"
      @drag-over="loaderDrag.onDragOver"
      @drag-end="loaderDrag.resetDrag"
      @drop="onLoaderDrop"
    >
      <template #before-name="{ item }">
        <span class="mics-badge">{{ LOADER_LABELS[item.kind] }}</span>
      </template>
    </SourceList>

    <SourceList
      :items="modSources"
      title="Mod 下载源"
      note="可添加镜像；CurseForge 需要 API Key"
      empty-text="尚未配置 Mod 下载源"
      :saved="modSaved"
      :is-default="modSourcesAreDefault"
      :drag-index="modDrag.dragIndex.value"
      :over-index="modDrag.overIndex.value"
      toggle-title="关闭后跳过该来源"
      :get-display-name="modDisplayName"
      @add="openModEditor(null)"
      @reset="resetModSources"
      @save="saveModSources"
      @edit="openModEditor"
      @delete="removeModSource"
      @toggle="setModSourceEnabled"
      @drag-start="modDrag.onDragStart"
      @drag-over="modDrag.onDragOver"
      @drag-end="modDrag.resetDrag"
      @drop="onModDrop"
    >
      <template #before-name="{ item }">
        <span class="mics-badge">{{ MOD_SOURCE_LABELS[item.kind] }}</span>
      </template>
      <template #after-name="{ item }">
        <span v-if="modSourceNeedsKey(item) && !item.key.trim()" class="settings-source__state">
          缺少 API Key
        </span>
      </template>
    </SourceList>

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
  </SettingsPage>
</template>

<style scoped>
.settings-number {
  flex: none;
  width: 96px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.settings-unit {
  flex: none;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.settings-cache {
  color: var(--mics-fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.settings-source__state {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}
</style>
