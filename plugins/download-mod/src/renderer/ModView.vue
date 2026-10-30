<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  MOD_LOADER_LABELS,
  MOD_LOADERS,
  MOD_OPEN_INTENT_KEY,
} from '@mics/sdk'
import type {
  GameVersion,
  ModCategory,
  ModLoader,
  ModReleaseChannel,
  ModSearchRequest,
  ModSearchResult,
  ModSourceError,
  ModSourceInfo,
  ModOpenIntent,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest,
  NotificationsServiceApi,
} from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'
import {
  DataBrowser,
  FilterButton,
  FilterPanel,
  isFilterActive,
} from '@mics/ui'
import type { FilterGroup, FilterSelection, ListRow } from '@mics/ui'
import ModInstallDialog from './ModInstallDialog.vue'

const ctx = usePluginContext()

const PAGE_SIZE = 20
const CHANNEL_LABELS: Record<ModReleaseChannel, string> = {
  release: '正式版',
  beta: '测试版',
  alpha: '早期版',
}

const CHANNEL_OPTIONS = [
  { value: 'all', label: '全部' },
  ...(Object.entries(CHANNEL_LABELS) as Array<[ModReleaseChannel, string]>)
    .map(([value, label]) => ({ value, label })),
]

const pageEl = ref<HTMLElement | null>(null)

const sources = ref<ModSourceInfo[]>([])
const categories = ref<ModCategory[]>([])
const gameVersions = ref<GameVersion[]>([])

const query = ref('')
const filterOpen = ref(false)
const filterPanelId = useId()
const filterSelection = ref<FilterSelection>({})

const page = ref(1)
const total = ref(0)
const results = ref<ModSummary[]>([])
const errors = ref<ModSourceError[]>([])
const loading = ref(false)
const searchError = ref('')
const searched = ref(false)

const activeMod = ref<ModSummary | null>(null)
const versions = ref<ModVersion[]>([])
const versionLoading = ref(false)
const versionError = ref('')
const versionQuery = ref('')
const versionFilter = ref<FilterSelection>({ sort: ['newest'] })

const installOpen = ref(false)
const installVersion = ref<ModVersion | null>(null)

const iconFailed = ref<Record<string, boolean>>({})

let ready = false
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0
let versionSeq = 0
/** 从实例 Mod 列表跳进来时，搜索完成后自动打开的项目 */
let pendingOpenIntent: ModOpenIntent | null = null

const enabledSources = computed(() => sources.value.filter((item) => item.enabled))
const readySources = computed(() => enabledSources.value.filter((item) => item.ready))
/** 同一类型配置多个镜像时只显示一个筛选项，搜索仍会查询全部镜像 */
const sourceOptions = computed(() => {
  const seen = new Set<ModSourceKind>()
  return readySources.value.filter((item) => {
    if (seen.has(item.kind)) return false
    seen.add(item.kind)
    return true
  })
})
const sourceWarning = computed(() => {
  const readyKinds = new Set(readySources.value.map((item) => item.kind))
  const unavailable = enabledSources.value.filter(
    (item) => !item.ready && !readyKinds.has(item.kind),
  )
  if (unavailable.length === 0) return ''
  return unavailable
    .map((item) => `${item.label} 不可用：${item.hint || '未配置'}`)
    .join('；')
})
const sourceErrors = computed(() =>
  errors.value.map((item) => `${item.label}：${item.message}`).join('；'),
)

const filterGroups = computed<FilterGroup[]>(() => [
  {
    key: 'source',
    label: '来源',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...sourceOptions.value.map((item) => ({ value: item.kind, label: item.label })),
    ],
  },
  {
    key: 'gameVersion',
    label: 'MC 版本',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...gameVersions.value
        .filter((item) => item.type === 'release')
        .map((item) => ({ value: item.id, label: item.id })),
    ],
  },
  {
    key: 'loader',
    label: 'Mod 加载器',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...MOD_LOADERS.map((item) => ({ value: item, label: MOD_LOADER_LABELS[item] })),
    ],
  },
  {
    key: 'category',
    label: '类型',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...categories.value.map((item) => ({ value: item.id, label: item.label })),
    ],
  },
])

const filterActive = computed(() => isFilterActive(filterSelection.value, filterGroups.value))

function filterValue(key: string): string {
  return filterSelection.value[key]?.[0] ?? 'all'
}

const selectedGameVersion = computed(() => {
  const value = filterValue('gameVersion')
  return value === 'all' ? '' : value
})

const selectedLoader = computed<ModLoader | 'all'>(() => {
  const value = filterValue('loader')
  return value === 'all' ? 'all' : value as ModLoader
})

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const pagerItems = computed(() => buildPagerItems(page.value, pageCount.value))

const versionById = computed(
  () => new Map(versions.value.map((version) => [version.id, version])),
)

/** 详情页的筛选不继承搜索页的版本/加载器限制，选项始终来自全部版本 */
const versionFilterGroups = computed<FilterGroup[]>(() => {
  const versionOptions = [...new Set(versions.value.flatMap((version) => version.gameVersions))]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((value) => ({ value, label: value }))
  const loaderOptions = [...new Set(versions.value.flatMap((version) => version.loaders))]
    .map((value) => ({ value, label: MOD_LOADER_LABELS[value] }))

  return [
    {
      key: 'gameVersion',
      label: 'MC 版本',
      mode: 'single',
      exclusive: 'all',
      options: [{ value: 'all', label: '全部' }, ...versionOptions],
    },
    {
      key: 'loader',
      label: '加载器',
      mode: 'single',
      exclusive: 'all',
      options: [{ value: 'all', label: '全部' }, ...loaderOptions],
    },
    {
      key: 'channel',
      label: '版本类型',
      mode: 'single',
      exclusive: 'all',
      options: CHANNEL_OPTIONS,
    },
    {
      key: 'sort',
      label: '排序方式',
      mode: 'single',
      affects: 'order',
      options: [
        { value: 'newest', label: '最新发布' },
        { value: 'oldest', label: '最早发布' },
      ],
    },
  ]
})

const versionRows = computed<ListRow[]>(() =>
  versions.value.map((version) => ({
    id: version.id,
    label: version.name,
    badge: CHANNEL_LABELS[version.channel],
    badgeAccent: version.channel === 'release',
    meta: [version.published.slice(0, 10), version.fileName].filter(Boolean).join(' · '),
    keywords: [
      version.versionNumber,
      version.fileName,
      ...version.gameVersions,
      ...version.loaders.map((item) => MOD_LOADER_LABELS[item]),
    ].filter(Boolean),
    tags: {
      channel: version.channel,
      gameVersion: version.gameVersions,
      loader: version.loaders,
    },
  })),
)

function formatDownloads(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`
  if (value >= 10_000) return `${Math.round(value / 10_000)} 万`
  return value.toLocaleString('zh-CN')
}

function buildPagerItems(current: number, count: number): Array<number | 'gap'> {
  if (count <= 7) return Array.from({ length: count }, (_value, index) => index + 1)
  const values = new Set<number>([1, count, current, current - 1, current + 1])
  const sorted = [...values]
    .filter((value) => value >= 1 && value <= count)
    .sort((a, b) => a - b)
  const items: Array<number | 'gap'> = []
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1]
    if (previous !== undefined && value - previous > 1) items.push('gap')
    items.push(value)
  })
  return items
}

function versionSort(a: ListRow, b: ListRow, selection: FilterSelection): number {
  const order = selection.sort?.[0] ?? 'newest'
  const left = versionById.value.get(a.id)?.published ?? ''
  const right = versionById.value.get(b.id)?.published ?? ''
  const byDate = order === 'oldest'
    ? left.localeCompare(right)
    : right.localeCompare(left)
  return byDate || a.label.localeCompare(b.label)
}

function markIconFailed(id: string): void {
  iconFailed.value = { ...iconFailed.value, [id]: true }
}

function scrollToTop(): void {
  void nextTick(() => pageEl.value?.scrollIntoView({ block: 'start' }))
}

function openDownloadSettings(): void {
  ctx.ui.navigate('settings.download')
}

async function runSearch(resetPage = false): Promise<void> {
  if (!ready) return
  if (resetPage) page.value = 1

  const seq = ++searchSeq
  loading.value = true
  searchError.value = ''
  errors.value = []

  const sourceFilter = filterValue('source')
  const categoryFilter = filterValue('category')
  const request: ModSearchRequest = {
    query: query.value.trim(),
    source: sourceFilter === 'all' ? 'all' : sourceFilter as ModSourceKind,
    gameVersion: selectedGameVersion.value,
    loader: selectedLoader.value,
    category: categoryFilter === 'all' ? '' : categoryFilter,
    page: page.value,
    pageSize: PAGE_SIZE,
  }

  try {
    const result = await ctx.ipc.invoke<ModSearchResult>(
      'mics.download.manager',
      'mods/search',
      request,
    )
    if (seq !== searchSeq) return

    results.value = result.items
    total.value = result.total
    errors.value = result.errors
    searched.value = true

    // 来源变少或结果被删除时，当前页可能越界，回到最后一页再取一次
    const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
    if (result.page > pages && page.value !== pages) {
      page.value = pages
      void runSearch(false)
    }
  } catch (cause) {
    if (seq !== searchSeq) return
    results.value = []
    total.value = 0
    errors.value = []
    searched.value = true
    searchError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (seq === searchSeq) loading.value = false
  }
}

function goToPage(next: number): void {
  if (next < 1 || next > pageCount.value || next === page.value) return
  page.value = next
  void runSearch(false)
  scrollToTop()
}

async function loadVersions(): Promise<void> {
  const mod = activeMod.value
  if (!mod) return
  const seq = ++versionSeq
  versionLoading.value = true
  versionError.value = ''
  versions.value = []

  // 详情页一次读取全部版本；实例或搜索页带来的版本/加载器只作为
  // 初始筛选，用户可以随时改回全部。
  const request: ModVersionRequest = {
    source: mod.source,
    ...(mod.sourceApi ? { sourceApi: mod.sourceApi } : {}),
    projectId: mod.projectId,
    gameVersion: '',
    loader: 'all',
  }

  try {
    const list = await ctx.ipc.invoke<ModVersion[]>(
      'mics.download.manager',
      'mods/versions',
      request,
    )
    if (seq !== versionSeq) return
    versions.value = list
  } catch (cause) {
    if (seq !== versionSeq) return
    versionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (seq === versionSeq) versionLoading.value = false
  }
}

function searchFilter(): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  if (selectedGameVersion.value) filter.gameVersion = [selectedGameVersion.value]
  if (selectedLoader.value !== 'all') filter.loader = [selectedLoader.value]
  return filter
}

function intentFilter(intent: ModOpenIntent): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  if (intent.gameVersion) filter.gameVersion = [intent.gameVersion]
  if (intent.loader && intent.loader !== 'all') filter.loader = [intent.loader]
  return filter
}

function openMod(mod: ModSummary, initialFilter = searchFilter()): void {
  activeMod.value = mod
  versionQuery.value = ''
  // 详情筛选的选择项仍来自全部版本；初始值来自搜索页或实例上下文。
  versionFilter.value = initialFilter
  installOpen.value = false
  installVersion.value = null
  void loadVersions()
  scrollToTop()
}

function closeMod(): void {
  versionSeq += 1
  activeMod.value = null
  versions.value = []
  versionError.value = ''
  installOpen.value = false
  installVersion.value = null
  scrollToTop()
}

function selectVersion(id: string): void {
  const version = versions.value.find((item) => item.id === id)
  if (!version) return
  installVersion.value = version
  installOpen.value = true
}

function closeInstall(): void {
  installOpen.value = false
  installVersion.value = null
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

  // 通知插件未加载或旧版本时退回服务方式
  ctx.notifications.show(options)
}

function loadFilterOptions(): void {
  void ctx.ipc.invoke<ModCategory[]>('mics.download.manager', 'mods/categories')
    .then((list) => { categories.value = list })
    .catch(() => undefined)
  void ctx.ipc.invoke<GameVersion[]>('mics.download.manager', 'versions/list')
    .then((list) => { gameVersions.value = list })
    .catch(() => undefined)
}

function takeOpenIntent(): ModOpenIntent | null {
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
    ? intent.loader as ModLoader
    : 'all'
  return {
    query: intent.query.trim(),
    ...(validProject ? { project: validProject } : {}),
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

function openPendingIntent(): void {
  const intent = pendingOpenIntent
  pendingOpenIntent = null
  if (!intent) return

  const targetName = (intent.name || intent.query).toLowerCase()
  const target = results.value.find(
    (item) => item.slug.toLowerCase() === targetName || item.name.toLowerCase() === targetName,
  )
    ?? results.value.find((item) => item.name.toLowerCase().includes(targetName))
    ?? results.value[0]
  if (target) openMod(target)
}

async function loadSources(): Promise<void> {
  try {
    sources.value = await ctx.ipc.invoke<ModSourceInfo[]>(
      'mics.download.manager',
      'mods/sources',
    )
  } catch (cause) {
    searchError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function loadPageData(): Promise<void> {
  // 从实例 Mod 列表跳进来且已经指纹识别到项目时，直接打开精确详情；
  // 没有精确结果才退回“按名称搜索 -> 打开首个匹配”。
  const intent = takeOpenIntent()
  if (intent?.project) {
    query.value = intent.project.name
    ready = true
    openMod(intent.project, intentFilter(intent))
    // 详情已经显示；后台准备搜索结果，返回列表时仍然可用
    void (async () => {
      await loadSources()
      loadFilterOptions()
      if (readySources.value.length > 0) await runSearch(true)
    })()
    return
  }

  if (intent) {
    query.value = intent.query
    pendingOpenIntent = intent
  }

  await loadSources()
  // 版本清单与类型表可以慢慢加载，不阻塞首屏的 Mod 搜索结果
  loadFilterOptions()

  // 配置里没有任何可用来源时不再发无意义的搜索请求
  if (readySources.value.length === 0) {
    ready = true
    searched.value = true
    return
  }

  ready = true
  await runSearch(true)
  openPendingIntent()
}

watch(query, () => {
  if (!ready) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch(true)
  }, 350)
})

watch(
  filterSelection,
  () => {
    if (!ready) return
    void runSearch(true)
  },
  { deep: true },
)

onMounted(loadPageData)

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  searchSeq += 1
  versionSeq += 1
})
</script>

<template>
  <div ref="pageEl" class="mics-page">
    <template v-if="activeMod">
      <header class="mod-detail__header">
        <button class="mics-button mics-button--ghost mics-button--small" @click="closeMod">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m15 6-6 6 6 6" />
          </svg>
          返回
        </button>

        <img
          v-if="activeMod.icon && !iconFailed[activeMod.id]"
          class="mod-detail__icon"
          :src="activeMod.icon"
          :alt="activeMod.name"
          @error="markIconFailed(activeMod.id)"
        />
        <span v-else class="mod-detail__icon mod-detail__icon--fallback">
          {{ activeMod.name.slice(0, 1).toUpperCase() }}
        </span>

        <div class="mod-detail__heading">
          <div class="mod-detail__title-row">
            <h1 class="mics-page__title">{{ activeMod.name }}</h1>
            <span class="mics-badge">{{ activeMod.sourceLabel }}</span>
          </div>
          <p class="mod-detail__meta">
            {{ activeMod.author || '未知作者' }} · 下载 {{ formatDownloads(activeMod.downloads) }}
          </p>
          <p class="mod-detail__summary">{{ activeMod.summary }}</p>
        </div>
      </header>

      <div v-if="versionLoading" class="mics-empty">正在获取版本列表…</div>
      <div v-else-if="versionError" class="mics-empty mics-empty--error">
        {{ versionError }}
        <button class="mics-empty__action" @click="loadVersions">重试</button>
      </div>
      <DataBrowser
        v-else
        :items="versionRows"
        :groups="versionFilterGroups"
        title="版本"
        search-placeholder="搜索版本"
        action-label="安装"
        empty-text="没有匹配的版本"
        :mono="false"
        :sort="versionSort"
        v-model:query="versionQuery"
        v-model:filter="versionFilter"
        @select="selectVersion"
      />
    </template>

    <template v-else>
      <header class="mics-page__header">
        <h1 class="mics-page__title">Mod</h1>
      </header>

      <div class="mics-toolbar">
        <input
          v-model="query"
          class="mics-input mics-toolbar__grow"
          type="text"
          placeholder="搜索 Mod 名称"
          aria-label="搜索 Mod 名称"
          spellcheck="false"
        />
        <FilterButton
          v-model:open="filterOpen"
          :active="filterActive"
          label="筛选"
          :aria-controls="filterPanelId"
        />
      </div>

      <FilterPanel
        v-if="filterOpen"
        :id="filterPanelId"
        v-model="filterSelection"
        :groups="filterGroups"
      />

      <p v-if="sourceWarning" class="mics-notice">{{ sourceWarning }}</p>
      <p v-if="searchError" class="mics-notice mics-notice--error">{{ searchError }}</p>
      <p v-else-if="sourceErrors" class="mics-notice mics-notice--error">{{ sourceErrors }}</p>

      <div v-if="loading && !results.length" class="mics-empty">正在搜索…</div>
      <div v-else-if="!results.length" class="mics-empty">
        <template v-if="readySources.length === 0">未启用可用的 Mod 下载源</template>
        <template v-else-if="searchError">搜索失败</template>
        <template v-else-if="sourceErrors">来源请求失败</template>
        <template v-else-if="searched">没有匹配的 Mod</template>
        <template v-else>正在准备搜索…</template>
        <button
          v-if="readySources.length === 0"
          class="mics-empty__action"
          @click="openDownloadSettings"
        >
          打开下载设置
        </button>
        <button
          v-else-if="searchError"
          class="mics-empty__action"
          @click="runSearch(false)"
        >
          重试
        </button>
      </div>
      <div v-else class="mics-grid mods-grid" :class="{ 'is-loading': loading }">
        <article
          v-for="mod in results"
          :key="mod.id"
          class="mics-card mods-card"
          role="button"
          tabindex="0"
          :aria-label="`查看 ${mod.name}`"
          @click="openMod(mod)"
          @keydown.enter="openMod(mod)"
          @keydown.space.prevent="openMod(mod)"
        >
          <div class="mods-card__head">
            <img
              v-if="mod.icon && !iconFailed[mod.id]"
              class="mods-card__icon"
              :src="mod.icon"
              :alt="mod.name"
              loading="lazy"
              @error="markIconFailed(mod.id)"
            />
            <span v-else class="mods-card__icon mods-card__icon--fallback">
              {{ mod.name.slice(0, 1).toUpperCase() }}
            </span>

            <div class="mods-card__title-block">
              <span class="mics-card__title">{{ mod.name }}</span>
              <span class="mics-card__meta">{{ mod.author || '未知作者' }}</span>
            </div>

            <span class="mics-badge">{{ mod.sourceLabel }}</span>
          </div>

          <p class="mics-card__text">{{ mod.summary }}</p>

          <div v-if="mod.categories.length" class="mods-card__tags">
            <span v-for="label in mod.categories.slice(0, 3)" :key="label" class="mods-tag">
              {{ label }}
            </span>
          </div>

          <div class="mics-card__foot">
            <span class="mics-card__meta">下载 {{ formatDownloads(mod.downloads) }}</span>
          </div>
        </article>
      </div>

      <nav v-if="pageCount > 1" class="mods-pager" aria-label="分页">
        <button
          class="mods-pager__button"
          type="button"
          :disabled="page <= 1"
          aria-label="上一页"
          @click="goToPage(page - 1)"
        >
          ‹
        </button>
        <template v-for="(item, index) in pagerItems" :key="`${item}-${index}`">
          <span v-if="item === 'gap'" class="mods-pager__gap">…</span>
          <button
            v-else
            class="mods-pager__button"
            :class="{ 'is-active': item === page }"
            type="button"
            :aria-current="item === page ? 'page' : undefined"
            @click="goToPage(item)"
          >
            {{ item }}
          </button>
        </template>
        <button
          class="mods-pager__button"
          type="button"
          :disabled="page >= pageCount"
          aria-label="下一页"
          @click="goToPage(page + 1)"
        >
          ›
        </button>
      </nav>
    </template>

    <ModInstallDialog
      :open="installOpen"
      :version="installVersion"
      @close="closeInstall"
      @started="onInstallStarted"
    />
  </div>
</template>

<style scoped>
.mics-page {
  min-height: 100%;
}

.mods-grid {
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.mods-grid.is-loading {
  opacity: 0.55;
  pointer-events: none;
}

.mods-card {
  cursor: pointer;
  text-align: left;
}

.mods-card:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.mods-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mods-card__icon,
.mods-card__icon--fallback {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  object-fit: cover;
}

.mods-card__icon--fallback {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #4c8dff, #7c5cff);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}

.mods-card__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mods-card__title-block .mics-card__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mods-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mods-tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.mods-pager {
  position: sticky;
  bottom: 10px;
  z-index: 2;
  align-self: center;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 5px;
  border: 1px solid var(--mics-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--mics-bg-elevated) 86%, transparent);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.35);
  backdrop-filter: blur(12px);
}

.mods-pager__button {
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border-radius: 999px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  transition: background 0.12s ease, color 0.12s ease;
}

.mods-pager__button:hover:not(:disabled) {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.mods-pager__button.is-active {
  background: var(--mics-accent);
  color: var(--mics-accent-fg);
}

.mods-pager__button:disabled {
  opacity: 0.35;
  cursor: default;
}

.mods-pager__gap {
  padding: 0 2px;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.mod-detail__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px;
}

.mod-detail__header > .mics-button {
  margin-top: 2px;
}

.mod-detail__icon,
.mod-detail__icon--fallback {
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 11px;
  object-fit: cover;
}

.mod-detail__icon--fallback {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #4c8dff, #7c5cff);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
}

.mod-detail__heading {
  flex: 1;
  min-width: 0;
}

.mod-detail__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.mod-detail__meta {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.mod-detail__summary {
  margin: 8px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.mics-notice--error {
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}

.mics-empty--error {
  color: var(--mics-danger);
}
</style>
