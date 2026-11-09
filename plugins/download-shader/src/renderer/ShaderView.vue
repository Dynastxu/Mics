<script setup lang="ts">
import { ref } from 'vue'
import { emitNotification } from '@mics/sdk'
import type {
  GameVersion,
  InstallStartResult,
  InstanceSummary,
  ModCategory,
  ModSourceInfo,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
  PackKind
} from '@mics/sdk'
import { usePluginContext, useOpenExternal } from '@mics/sdk/renderer'
import { CatalogBrowser, PackInstallDialog } from '@mics/ui'
import type {
  CatalogCategory,
  CatalogGameVersion,
  CatalogItem,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSourceInfo,
  CatalogVersion
} from '@mics/ui'

const KIND: PackKind = 'shader'
const ctx = usePluginContext()
const openExternal = useOpenExternal()

const installOpen = ref(false)
const installVersion = ref<CatalogVersion | null>(null)
const instances = ref<InstanceSummary[]>([])
const instancesLoading = ref(false)
const instancesError = ref('')
const installing = ref(false)
const installError = ref('')

async function fetchSources(): Promise<CatalogSourceInfo[]> {
  return ctx.ipc.invoke<ModSourceInfo[]>('mics.download.catalog', 'packs/sources', { kind: KIND })
}

async function fetchCategories(): Promise<CatalogCategory[]> {
  return ctx.ipc.invoke<ModCategory[]>('mics.download.catalog', 'packs/categories', { kind: KIND })
}

async function fetchGameVersions(): Promise<CatalogGameVersion[]> {
  return ctx.ipc.invoke<GameVersion[]>('mics.download.game', 'versions/list')
}

async function search(request: CatalogSearchRequest): Promise<CatalogSearchResult> {
  return ctx.ipc.invoke('mics.download.catalog', 'packs/search', {
    kind: KIND,
    query: request.query,
    source: request.source as ModSourceKind | 'all',
    gameVersion: request.gameVersion,
    loader: 'all',
    category: '',
    page: request.page,
    pageSize: request.pageSize
  })
}

async function fetchVersions(item: CatalogItem): Promise<CatalogVersion[]> {
  const request: ModVersionRequest = {
    source: item.source as ModSourceKind,
    ...(item.sourceApi ? { sourceApi: item.sourceApi } : {}),
    projectId: item.projectId,
    gameVersion: '',
    loader: 'all'
  }
  return ctx.ipc.invoke<ModVersion[]>('mics.download.catalog', 'packs/versions', {
    kind: KIND,
    ...request
  })
}

async function fetchProject(item: CatalogItem): Promise<CatalogItem> {
  return ctx.ipc.invoke<ModSummary>('mics.download.catalog', 'packs/project', {
    kind: KIND,
    source: item.source as ModSourceKind,
    ...(item.sourceApi ? { sourceApi: item.sourceApi } : {}),
    projectId: item.projectId
  })
}

async function loadInstances(): Promise<void> {
  instancesLoading.value = true
  instancesError.value = ''
  try {
    await ctx.plugins.activate('mics.launch')
    instances.value = await ctx.ipc.invoke<InstanceSummary[]>('mics.launch', 'instances/list')
  } catch (cause) {
    instancesError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    instancesLoading.value = false
  }
}

function openInstall(version: CatalogVersion): void {
  installVersion.value = version
  installError.value = ''
  installOpen.value = true
  void loadInstances()
}

function closeInstall(): void {
  if (installing.value) return
  installOpen.value = false
  installVersion.value = null
}

function notify(version: CatalogVersion, instanceCount: number): void {
  const options = {
    level: 'info' as const,
    title: '已开始安装',
    message: `光影包 ${version.name} 已加入下载队列（${instanceCount} 个实例），可在「下载进度」查看。`,
    duration: 0
  }

  emitNotification(ctx, options)
}

async function install(payload: { instanceNames: string[] }): Promise<void> {
  const version = installVersion.value
  if (!version || installing.value) return
  installing.value = true
  installError.value = ''
  try {
    const outcome = await ctx.ipc.invoke<InstallStartResult>(
      'mics.download.shader',
      'packs/install',
      {
        kind: KIND,
        file: {
          url: version.fileUrl,
          fileName: version.fileName,
          sha1: version.sha1,
          size: version.size
        },
        instanceNames: payload.instanceNames,
        title: version.name
      }
    )
    if (outcome.error) {
      installError.value = outcome.error
      return
    }
    installing.value = false
    installOpen.value = false
    installVersion.value = null
    notify(version, payload.instanceNames.length)
  } catch (cause) {
    installError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    installing.value = false
  }
}

function openDownloadSettings(): void {
  ctx.ui.navigate('settings.download')
}
</script>

<template>
  <CatalogBrowser
    title="光影包"
    entity-label="光影包"
    search-placeholder="搜索光影包"
    empty-text="没有匹配的光影包"
    :loaders="[]"
    :show-loader-filter="false"
    :fetch-sources="fetchSources"
    :fetch-categories="fetchCategories"
    :fetch-game-versions="fetchGameVersions"
    :search="search"
    :fetch-versions="fetchVersions"
    :fetch-project="fetchProject"
    :open-external="openExternal"
    @install="openInstall"
    @settings="openDownloadSettings"
  />

  <PackInstallDialog
    :open="installOpen"
    :kind="KIND"
    :pack-name="installVersion?.name ?? ''"
    :file-name="installVersion?.fileName ?? ''"
    :game-versions="installVersion?.gameVersions ?? []"
    :instances="instances"
    :loading="instancesLoading"
    :installing="installing"
    :error="installError || instancesError"
    @close="closeInstall"
    @install="install"
  />
</template>
