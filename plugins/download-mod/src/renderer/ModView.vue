<script setup lang="ts">
import { ref } from 'vue'
import {
  MOD_LOADER_LABELS,
  MOD_LOADERS,
  MOD_OPEN_INTENT_KEY,
} from '@mics/sdk'
import type {
  ModLoader,
  ModOpenIntent,
  ModSourceInfo,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
  ModCategory,
  GameVersion,
  NotificationsServiceApi,
} from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'
import { CatalogBrowser } from '@mics/ui'
import type {
  CatalogCategory,
  CatalogGameVersion,
  CatalogIntent,
  CatalogItem,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSourceInfo,
  CatalogVersion,
} from '@mics/ui'
import ModInstallDialog from './ModInstallDialog.vue'

const ctx = usePluginContext()

const CHANNEL_LABELS = {
  release: '正式版',
  beta: '测试版',
  alpha: '早期版',
}

const loaders = MOD_LOADERS.map((value) => ({
  value,
  label: MOD_LOADER_LABELS[value],
}))

const browser = ref<InstanceType<typeof CatalogBrowser> | null>(null)
const installOpen = ref(false)
const installVersion = ref<CatalogVersion | null>(null)

function takeOpenIntent(): CatalogIntent | null {
  const store = globalThis as typeof globalThis & Record<string, unknown>
  const value = store[MOD_OPEN_INTENT_KEY]
  if (!value || typeof value !== 'object') return null
  delete store[MOD_OPEN_INTENT_KEY]
  const intent = value as Partial<ModOpenIntent>
  if (typeof intent.query !== 'string' || !intent.query.trim()) return null
  const project = intent.project
  const validProject = project
    && typeof project.projectId === 'string'
    && typeof project.name === 'string'
    && (project.source === 'modrinth' || project.source === 'curseforge')
    ? project
    : undefined
  const loader = typeof intent.loader === 'string'
    && MOD_LOADERS.includes(intent.loader as ModLoader)
    ? intent.loader
    : 'all'
  return {
    query: intent.query.trim(),
    ...(validProject ? { project: validProject as CatalogItem } : {}),
    ...(typeof intent.name === 'string' && intent.name.trim()
      ? { name: intent.name.trim() }
      : {}),
    ...(typeof intent.fileName === 'string' ? { fileName: intent.fileName } : {}),
    ...(typeof intent.gameVersion === 'string' && intent.gameVersion
      ? { gameVersion: intent.gameVersion }
      : {}),
    ...(loader !== 'all' ? { loader } : {}),
    ...(typeof intent.versionId === 'string' && intent.versionId
      ? { versionId: intent.versionId }
      : {}),
  }
}

const intent = ref<CatalogIntent | null>(takeOpenIntent())

async function fetchSources(): Promise<CatalogSourceInfo[]> {
  return ctx.ipc.invoke<ModSourceInfo[]>('mics.download.manager', 'mods/sources')
}

async function fetchCategories(): Promise<CatalogCategory[]> {
  return ctx.ipc.invoke<ModCategory[]>('mics.download.manager', 'mods/categories')
}

async function fetchGameVersions(): Promise<CatalogGameVersion[]> {
  return ctx.ipc.invoke<GameVersion[]>('mics.download.manager', 'versions/list')
}

async function search(request: CatalogSearchRequest): Promise<CatalogSearchResult> {
  return ctx.ipc.invoke('mics.download.manager', 'mods/search', {
    query: request.query,
    source: request.source as ModSourceKind | 'all',
    gameVersion: request.gameVersion,
    loader: request.loader as ModLoader | 'all',
    category: request.category,
    page: request.page,
    pageSize: request.pageSize,
  })
}

async function fetchVersions(item: CatalogItem): Promise<CatalogVersion[]> {
  const request: ModVersionRequest = {
    source: item.source as ModSourceKind,
    ...(item.sourceApi ? { sourceApi: item.sourceApi } : {}),
    projectId: item.projectId,
    gameVersion: '',
    loader: 'all',
  }
  return ctx.ipc.invoke<ModVersion[]>('mics.download.manager', 'mods/versions', request)
}

async function fetchProject(item: CatalogItem): Promise<CatalogItem> {
  return ctx.ipc.invoke<ModSummary>('mics.download.manager', 'mods/project', {
    source: item.source as ModSourceKind,
    ...(item.sourceApi ? { sourceApi: item.sourceApi } : {}),
    projectId: item.projectId,
  })
}

function openInstall(version: CatalogVersion): void {
  installVersion.value = version
  installOpen.value = true
}

function closeInstall(): void {
  installOpen.value = false
  installVersion.value = null
}

function openDownloadSettings(): void {
  ctx.ui.navigate('settings.download')
}

function onInstallStarted(_jobId: string, instanceCount: number): void {
  const version = installVersion.value
  closeInstall()
  void ctx.ipc.invoke('mics.logger', 'log/write', {
    level: 'debug',
    args: ['[notifications] 显示安装通知：%s', version?.name ?? ''],
  }).catch(() => undefined)
  const options = {
    level: 'info' as const,
    title: '已开始安装',
    message: version
      ? `${version.name} 已加入下载队列（${instanceCount} 个实例），可在「下载进度」查看。`
      : `Mod 已加入下载队列（${instanceCount} 个实例），可在「下载进度」查看。`,
    // 安装通知不自动消失，避免用户切回窗口时已经错过
    duration: 0,
  }

  // 优先走通知插件暴露的全局入口；它不受插件 fiber 之间服务可见性的影响。
  const globalApi = (globalThis as typeof globalThis & {
    __MICS_NOTIFICATIONS__?: NotificationsServiceApi
  }).__MICS_NOTIFICATIONS__
  if (globalApi) {
    globalApi.show(options)
    return
  }

  ctx.notifications.show(options)
}
</script>

<template>
  <CatalogBrowser
    ref="browser"
    title="Mod"
    entity-label="Mod"
    search-placeholder="搜索 Mod 名称"
    empty-text="没有匹配的 Mod"
    version-title="版本"
    version-search-placeholder="搜索版本"
    :loaders="loaders"
    :channel-labels="CHANNEL_LABELS"
    :intent="intent"
    :fetch-sources="fetchSources"
    :fetch-categories="fetchCategories"
    :fetch-game-versions="fetchGameVersions"
    :search="search"
    :fetch-versions="fetchVersions"
    :fetch-project="fetchProject"
    @install="openInstall"
    @settings="openDownloadSettings"
  >
    <template #version-extra="{ version, selected }">
      <div
        v-if="selected && (version?.dependencies ?? []).some((item) => item.kind === 'required' && item.name)"
        class="version-deps"
      >
        <span class="version-deps__label">前置</span>
        <button
          v-for="dependency in (version?.dependencies ?? []).filter((item) => item.kind === 'required' && item.name)"
          :key="`${dependency.projectId}:${dependency.name}`"
          class="version-deps__chip"
          type="button"
          :disabled="!dependency.project"
          :title="dependency.project ? `打开 ${dependency.name}` : undefined"
          @click.stop="dependency.project && browser?.openRelated(dependency.project)"
          @keydown.enter.stop
          @keydown.space.stop
        >
          {{ dependency.name }}
          <span v-if="dependency.project" class="version-deps__arrow" aria-hidden="true">↗</span>
        </button>
      </div>
    </template>
  </CatalogBrowser>

  <ModInstallDialog
    :open="installOpen"
    :version="installVersion"
    @close="closeInstall"
    @started="onInstallStarted"
  />
</template>

<style scoped>
.version-deps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}

.version-deps__label {
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.version-deps__chip {
  padding: 1px 8px;
  border: 1px solid var(--mics-border);
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
  font-size: 10.5px;
  transition: border-color 0.12s ease, color 0.12s ease;
}

.version-deps__chip:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--mics-accent) 55%, var(--mics-border));
  color: var(--mics-accent);
}

.version-deps__chip:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.version-deps__chip:disabled {
  color: var(--mics-fg-muted);
  cursor: default;
}

.version-deps__arrow {
  margin-left: 3px;
  opacity: 0.6;
}
</style>
