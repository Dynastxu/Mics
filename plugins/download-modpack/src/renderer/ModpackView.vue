<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  INSTANCE_NAME_MAX_LENGTH,
  MOD_LOADER_LABELS,
  MOD_LOADERS,
  sanitizeInstanceName,
  validateInstanceName,
} from '@mics/sdk'
import type {
  GameVersion,
  InstallStartResult,
  InstanceNameCheck,
  ModCategory,
  ModLoader,
  ModSourceInfo,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
  NotificationsServiceApi,
} from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'
import { CatalogBrowser, InstanceInstallDialog } from '@mics/ui'
import type {
  CatalogCategory,
  CatalogGameVersion,
  CatalogItem,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSourceInfo,
  CatalogVersion,
} from '@mics/ui'

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

const SUPPORTED_LOADERS = new Set(['fabric', 'forge', 'neoforge'])

const activePack = ref<CatalogItem | null>(null)
const installOpen = ref(false)
const installVersion = ref<CatalogVersion | null>(null)
const installing = ref(false)
const installError = ref('')

const defaultName = computed(() => {
  const raw = activePack.value?.name || installVersion.value?.name || '整合包'
  const cleaned = sanitizeInstanceName(raw).trim().replace(/[. ]+$/, '')
  return [...cleaned].slice(0, INSTANCE_NAME_MAX_LENGTH).join('') || '整合包'
})

const blockedReason = computed(() => {
  const version = installVersion.value
  if (!version) return ''
  const supported = version.loaders.filter((loader) => SUPPORTED_LOADERS.has(loader))
  if (version.loaders.length > 0 && supported.length === 0) {
    const labels = version.loaders.map((loader) => MOD_LOADER_LABELS[loader as ModLoader] ?? loader)
    return `暂不支持 ${labels.join(' / ')} 加载器，无法安装该整合包`
  }
  return ''
})

function formatBytes(value: number): string {
  if (value <= 0) return '未知'
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const details = computed(() => {
  const version = installVersion.value
  if (!version) return []
  return [
    { label: '游戏版本', value: version.gameVersions.join(' / ') || '读取整合包清单' },
    {
      label: '加载器',
      value: version.loaders.map((loader) => MOD_LOADER_LABELS[loader as ModLoader] ?? loader)
        .join(' / ') || '原版',
    },
    { label: '包大小', value: formatBytes(version.size) },
  ]
})

async function fetchSources(): Promise<CatalogSourceInfo[]> {
  return ctx.ipc.invoke<ModSourceInfo[]>('mics.download.manager', 'modpacks/sources')
}

async function fetchCategories(): Promise<CatalogCategory[]> {
  return ctx.ipc.invoke<ModCategory[]>('mics.download.manager', 'modpacks/categories')
}

async function fetchGameVersions(): Promise<CatalogGameVersion[]> {
  return ctx.ipc.invoke<GameVersion[]>('mics.download.manager', 'versions/list')
}

async function search(request: CatalogSearchRequest): Promise<CatalogSearchResult> {
  return ctx.ipc.invoke('mics.download.manager', 'modpacks/search', {
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
  return ctx.ipc.invoke<ModVersion[]>('mics.download.manager', 'modpacks/versions', request)
}

async function fetchProject(item: CatalogItem): Promise<CatalogItem> {
  return ctx.ipc.invoke<ModSummary>('mics.download.manager', 'modpacks/project', {
    source: item.source as ModSourceKind,
    ...(item.sourceApi ? { sourceApi: item.sourceApi } : {}),
    projectId: item.projectId,
  })
}

async function checkName(name: string): Promise<InstanceNameCheck> {
  try {
    return await ctx.ipc.invoke<InstanceNameCheck>(
      'mics.download.manager',
      'install/validate-name',
      { name },
    )
  } catch {
    return validateInstanceName(name)
  }
}

function onOpen(item: CatalogItem): void {
  activePack.value = item
}

function openInstall(version: CatalogVersion): void {
  installVersion.value = version
  installError.value = ''
  installOpen.value = true
}

function closeInstall(): void {
  if (installing.value) return
  installOpen.value = false
  installVersion.value = null
  installError.value = ''
}

function openDownloadSettings(): void {
  ctx.ui.navigate('settings.download')
}

function notify(message: string): void {
  const options = {
    level: 'info' as const,
    title: '已开始安装',
    message,
    // 安装通知不自动消失，避免用户切回窗口时已经错过
    duration: 0,
  }
  const globalApi = (globalThis as typeof globalThis & {
    __MICS_NOTIFICATIONS__?: NotificationsServiceApi
  }).__MICS_NOTIFICATIONS__
  if (globalApi) {
    globalApi.show(options)
    return
  }
  ctx.notifications.show(options)
}

async function install(name: string): Promise<void> {
  const version = installVersion.value
  if (!version || installing.value || blockedReason.value) return
  installing.value = true
  installError.value = ''
  try {
    const result = await ctx.ipc.invoke<InstallStartResult>(
      'mics.download.manager',
      'modpacks/install',
      {
        instanceName: name,
        title: activePack.value?.name || version.name,
        version: version.versionNumber || version.name,
        file: {
          url: version.fileUrl,
          fileName: version.fileName,
          sha1: version.sha1,
          size: version.size,
        },
        source: version.source as ModSourceKind,
        ...(activePack.value?.sourceApi ? { sourceApi: activePack.value.sourceApi } : {}),
      },
    )
    if (result.error) {
      installError.value = result.error
      return
    }
    installOpen.value = false
    installVersion.value = null
    notify(`「${name}」已加入下载队列，可在「下载进度」查看。`)
  } catch (cause) {
    installError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <CatalogBrowser
    title="整合包"
    entity-label="整合包"
    search-placeholder="搜索整合包"
    empty-text="没有匹配的整合包"
    version-title="整合包版本"
    version-search-placeholder="搜索整合包版本"
    :loaders="loaders"
    :channel-labels="CHANNEL_LABELS"
    :fetch-sources="fetchSources"
    :fetch-categories="fetchCategories"
    :fetch-game-versions="fetchGameVersions"
    :search="search"
    :fetch-versions="fetchVersions"
    :fetch-project="fetchProject"
    @open="onOpen"
    @install="openInstall"
    @settings="openDownloadSettings"
  />

  <InstanceInstallDialog
    :open="installOpen"
    title="安装整合包"
    :subtitle="installVersion?.name"
    :default-name="defaultName"
    :check-name="checkName"
    :installing="installing"
    :error="installError"
    :details="details"
    :blocked-reason="blockedReason"
    @close="closeInstall"
    @install="install"
  />
</template>
