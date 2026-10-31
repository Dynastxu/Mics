<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import BackToTop from './BackToTop.vue'
import CatalogCard from './CatalogCard.vue'
import DataBrowser from './DataBrowser.vue'
import FilterButton from './FilterButton.vue'
import FilterPanel from './FilterPanel.vue'
import ListPager from './ListPager.vue'
import { formatDownloads } from './catalog'
import { isFilterActive } from './list'
import type {
  CatalogCategory,
  CatalogGameVersion,
  CatalogIntent,
  CatalogItem,
  CatalogLoaderOption,
  CatalogOpenOptions,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSourceError,
  CatalogSourceInfo,
  CatalogVersion,
} from './catalog'
import type { FilterGroup, FilterSelection, ListRow } from './types'

/**
 * 通用内容目录浏览。
 *
 * 交互固定为「搜索项目 -> 进入详情 -> 选择版本 -> 安装」，Mod / 整合包等
 * 下载分类只需要注入自己的 IPC 调用和少量插槽，不再各写一份搜索、筛选、
 * 分页、详情返回栈与滚动恢复。
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** 用于按钮 title / 空状态的业务名称，例如「Mod」「整合包」 */
    entityLabel?: string
    searchPlaceholder: string
    emptyText: string
    versionTitle?: string
    versionSearchPlaceholder?: string
    pageSize?: number
    /** 加载器筛选项；由页面传入，组件不绑定具体业务枚举 */
    loaders: CatalogLoaderOption[]
    /** 发布渠道显示名，默认 release / beta / alpha */
    channelLabels?: Record<string, string>
    fetchSources: () => Promise<CatalogSourceInfo[]>
    fetchCategories: () => Promise<CatalogCategory[]>
    fetchGameVersions: () => Promise<CatalogGameVersion[]>
    search: (request: CatalogSearchRequest) => Promise<CatalogSearchResult>
    fetchVersions: (item: CatalogItem) => Promise<CatalogVersion[]>
    /** 可选：补齐项目作者等摘要信息 */
    fetchProject?: (item: CatalogItem) => Promise<CatalogItem>
    /** 从其它页面跳进来时的一次性意图 */
    intent?: CatalogIntent | null
  }>(),
  {
    entityLabel: '项目',
    versionTitle: '版本',
    versionSearchPlaceholder: '搜索版本',
    pageSize: 20,
    channelLabels: () => ({ release: '正式版', beta: '测试版', alpha: '早期版' }),
    intent: null,
  },
)

const emit = defineEmits<{
  open: [item: CatalogItem]
  install: [version: CatalogVersion]
  settings: []
}>()

const pageEl = ref<HTMLElement | null>(null)
const detailIconFailed = ref(false)

/** 页面真正的滚动容器（shell 的 .mics-main__page）；挂载后缓存 */
let pageScrollEl: HTMLElement | null = null
const showBackToTop = ref(false)
const BACK_TO_TOP_THRESHOLD = 240

function onPageScroll(): void {
  showBackToTop.value = (pageScrollEl?.scrollTop ?? 0) > BACK_TO_TOP_THRESHOLD
}

const sources = ref<CatalogSourceInfo[]>([])
const categories = ref<CatalogCategory[]>([])
const gameVersions = ref<CatalogGameVersion[]>([])

const query = ref('')
const filterOpen = ref(false)
const filterPanelId = useId()
const filterSelection = ref<FilterSelection>({})

const page = ref(1)
const total = ref(0)
const results = ref<CatalogItem[]>([])
const errors = ref<CatalogSourceError[]>([])
const loading = ref(false)
const searchError = ref('')
const searched = ref(false)

const activeItem = ref<CatalogItem | null>(null)
const versions = ref<CatalogVersion[]>([])
const versionLoading = ref(false)
const versionError = ref('')
const versionQuery = ref('')
const versionFilter = ref<FilterSelection>({ sort: ['newest'] })
const selectedVersionId = ref('')

interface CatalogSnapshot {
  item: CatalogItem
  filter: FilterSelection
  query: string
  selectedVersionId: string
  scrollTop: number
}

const history = ref<CatalogSnapshot[]>([])
let pendingScrollTop: number | null = null
let searchScrollTop = 0

let ready = false
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0
let versionSeq = 0
let pendingIntent: CatalogIntent | null = null

const enabledSources = computed(() => sources.value.filter((item) => item.enabled))
const readySources = computed(() => enabledSources.value.filter((item) => item.ready))

/** 同一类型配置多个镜像时只显示一个筛选项，搜索仍会查询全部镜像 */
const sourceOptions = computed(() => {
  const seen = new Set<string>()
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

const loaderLabels = computed(() => {
  const map = new Map<string, string>()
  for (const loader of props.loaders) map.set(loader.value, loader.label)
  return map
})

function loaderLabel(value: string): string {
  return loaderLabels.value.get(value) ?? value
}

function channelLabel(value: string): string {
  return props.channelLabels[value] ?? value
}

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
    label: '加载器',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...props.loaders.map((item) => ({ value: item.value, label: item.label })),
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

const selectedLoader = computed(() => {
  const value = filterValue('loader')
  return value === 'all' ? 'all' : value
})

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / props.pageSize)))

const versionById = computed(
  () => new Map(versions.value.map((version) => [version.id, version])),
)

const selectedVersion = computed(
  () => versions.value.find((version) => version.id === selectedVersionId.value) ?? null,
)

/** 详情页筛选不继承搜索页的版本/加载器限制，选项始终来自全部版本 */
const versionFilterGroups = computed<FilterGroup[]>(() => {
  const versionOptions = [...new Set(versions.value.flatMap((version) => version.gameVersions))]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((value) => ({ value, label: value }))
  const loaderOptions = [...new Set(versions.value.flatMap((version) => version.loaders))]
    .map((value) => ({ value, label: loaderLabel(value) }))

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
      options: [
        { value: 'all', label: '全部' },
        ...Object.entries(props.channelLabels).map(([value, label]) => ({ value, label })),
      ],
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
    badge: channelLabel(version.channel),
    badgeAccent: version.channel === 'release',
    meta: [version.published.slice(0, 10), version.fileName].filter(Boolean).join(' · '),
    keywords: [
      version.versionNumber,
      version.fileName,
      ...version.gameVersions,
      ...version.loaders.map(loaderLabel),
    ].filter(Boolean),
    tags: {
      channel: version.channel,
      gameVersion: version.gameVersions,
      loader: version.loaders,
    },
  })),
)

function versionOfRow(id: string): CatalogVersion | undefined {
  return versionById.value.get(id)
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

function scrollToTop(): void {
  void nextTick(() => pageEl.value?.scrollIntoView({ block: 'start' }))
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
  const request: CatalogSearchRequest = {
    query: query.value.trim(),
    source: sourceFilter === 'all' ? 'all' : sourceFilter,
    gameVersion: selectedGameVersion.value,
    loader: selectedLoader.value,
    category: categoryFilter === 'all' ? '' : categoryFilter,
    page: page.value,
    pageSize: props.pageSize,
  }

  try {
    const result = await props.search(request)
    if (seq !== searchSeq) return

    results.value = result.items
    total.value = result.total
    errors.value = result.errors
    searched.value = true

    const pages = Math.max(1, Math.ceil(result.total / props.pageSize))
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
  const item = activeItem.value
  if (!item) return
  const seq = ++versionSeq
  versionLoading.value = true
  versionError.value = ''
  versions.value = []

  let loaded = false
  try {
    const list = await props.fetchVersions(item)
    if (seq !== versionSeq) return
    versions.value = list
    loaded = true
  } catch (cause) {
    if (seq !== versionSeq) return
    versionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (seq === versionSeq) {
      versionLoading.value = false
      // 必须等 versionLoading 触发的这次渲染结束：此时列表还没挂载，
      // 直接设 scrollTop 会被「正在获取版本列表」的短内容钳成 0。
      if (loaded && pendingScrollTop !== null) {
        const top = pendingScrollTop
        pendingScrollTop = null
        restoreScroll(top)
      } else if (loaded && selectedVersionId.value) {
        scrollToSelectedVersion()
      }
    }
  }
}

function searchFilter(): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  if (selectedGameVersion.value) filter.gameVersion = [selectedGameVersion.value]
  if (selectedLoader.value !== 'all') filter.loader = [selectedLoader.value]
  return filter
}

function intentFilter(intent: CatalogIntent): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  if (intent.gameVersion) filter.gameVersion = [intent.gameVersion]
  if (intent.loader && intent.loader !== 'all') filter.loader = [intent.loader]
  return filter
}

/** 前置跳转保留当前的 MC 版本 / 加载器筛选，方便直接挑对应版本的依赖 */
function relatedFilter(): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  const gameVersion = versionFilter.value.gameVersion?.[0]
  if (gameVersion && gameVersion !== 'all') filter.gameVersion = [gameVersion]
  const loader = versionFilter.value.loader?.[0]
  if (loader && loader !== 'all') filter.loader = [loader]
  return filter
}

function pageScrollParent(): HTMLElement | null {
  let node = pageEl.value?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

function selectedRowElement(): HTMLElement | null {
  return pageEl.value?.querySelector<HTMLElement>('.mics-list__row.is-selected') ?? null
}

function snapshot(): CatalogSnapshot | null {
  if (!activeItem.value) return null
  return {
    item: activeItem.value,
    filter: { ...versionFilter.value },
    query: versionQuery.value,
    selectedVersionId: selectedVersionId.value,
    scrollTop: pageScrollParent()?.scrollTop ?? 0,
  }
}

async function hydrate(item: CatalogItem): Promise<void> {
  if (item.author || !props.fetchProject) return
  try {
    const summary = await props.fetchProject(item)
    if (activeItem.value?.id === item.id) activeItem.value = summary
  } catch {
    // 作者只是展示信息，查不到就保持原样
  }
}

function openItem(item: CatalogItem, options: CatalogOpenOptions = {}): void {
  const current = snapshot()
  if (options.remember && current) history.value.push(current)
  // 从搜索结果进入详情前记下滚动位置；从另一个详情跳过来时保持原值
  if (!activeItem.value) searchScrollTop = pageScrollParent()?.scrollTop ?? 0
  pendingScrollTop = null
  showBackToTop.value = false
  detailIconFailed.value = false
  activeItem.value = item
  selectedVersionId.value = ''
  versionQuery.value = ''
  versionFilter.value = options.filter ?? searchFilter()
  void loadVersions()
  void hydrate(item)
  scrollToTop()
  emit('open', item)
}

/** 前置跳转：保留当前详情版本筛选，返回时回到原详情 */
function openRelated(item: CatalogItem): void {
  openItem(item, { filter: relatedFilter(), remember: true })
}

function restoreItem(snapshotValue: CatalogSnapshot): void {
  activeItem.value = snapshotValue.item
  detailIconFailed.value = false
  versionQuery.value = snapshotValue.query
  versionFilter.value = snapshotValue.filter
  selectedVersionId.value = snapshotValue.selectedVersionId
  pendingScrollTop = snapshotValue.scrollTop
  void loadVersions()
  void hydrate(snapshotValue.item)
}

function restoreScroll(top: number): void {
  const apply = (attempt: number): void => {
    const container = pageScrollParent()
    if (!container) {
      if (attempt < 3) {
        requestAnimationFrame(() => apply(attempt + 1))
        return
      }
      selectedRowElement()?.scrollIntoView({ block: 'center' })
      return
    }

    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    if (maxScroll + 1 < top && attempt < 3) {
      requestAnimationFrame(() => apply(attempt + 1))
      return
    }

    container.scrollTop = Math.min(top, maxScroll)

    const row = selectedRowElement()
    if (!row) return
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < containerRect.top || rowRect.bottom > containerRect.bottom) {
      row.scrollIntoView({ block: 'center' })
    }
  }

  void nextTick(() => requestAnimationFrame(() => apply(0)))
}

function scrollToSelectedVersion(): void {
  void nextTick(() => {
    requestAnimationFrame(() => {
      selectedRowElement()?.scrollIntoView({ block: 'center' })
    })
  })
}

function closeToSearch(): void {
  versionSeq += 1
  pendingScrollTop = null
  history.value = []
  activeItem.value = null
  versions.value = []
  versionError.value = ''
  selectedVersionId.value = ''

  const top = searchScrollTop
  void nextTick(() => {
    const container = pageScrollParent()
    if (container) container.scrollTop = top
  })
}

function goHome(): void {
  closeToSearch()
}

function closeItem(): void {
  const previous = history.value.pop()
  if (!previous) {
    closeToSearch()
    return
  }
  versionSeq += 1
  restoreItem(previous)
}

function selectVersion(id: string): void {
  selectedVersionId.value = id
}

function openInstall(): void {
  const version = selectedVersion.value
  if (version) emit('install', version)
}

function backToTop(): void {
  const container = pageScrollEl ?? pageScrollParent()
  if (container) container.scrollTo({ top: 0, behavior: 'smooth' })
  else scrollToTop()
}

function loadFilterOptions(): void {
  void props.fetchCategories()
    .then((list) => { categories.value = list })
    .catch(() => undefined)
  void props.fetchGameVersions()
    .then((list) => { gameVersions.value = list })
    .catch(() => undefined)
}

function openPendingIntent(): void {
  const intent = pendingIntent
  pendingIntent = null
  if (!intent) return

  const targetName = (intent.name || intent.query).toLowerCase()
  const target = results.value.find(
    (item) => item.slug.toLowerCase() === targetName || item.name.toLowerCase() === targetName,
  )
    ?? results.value.find((item) => item.name.toLowerCase().includes(targetName))
    ?? results.value[0]
  if (target) openItem(target)
}

async function loadSources(): Promise<void> {
  try {
    sources.value = await props.fetchSources()
  } catch (cause) {
    searchError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function loadPageData(): Promise<void> {
  const intent = props.intent
  if (intent?.project) {
    query.value = intent.project.name
    ready = true
    openItem(intent.project, { filter: intentFilter(intent) })
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
    pendingIntent = intent
  }

  await loadSources()
  loadFilterOptions()

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

onMounted(() => {
  pageScrollEl = pageScrollParent()
  pageScrollEl?.addEventListener('scroll', onPageScroll, { passive: true })
  onPageScroll()
  void loadPageData()
})

onBeforeUnmount(() => {
  pageScrollEl?.removeEventListener('scroll', onPageScroll)
  pageScrollEl = null
  if (searchTimer) clearTimeout(searchTimer)
  searchSeq += 1
  versionSeq += 1
})

defineExpose({
  openItem,
  openRelated,
  closeItem,
  closeToSearch,
  refresh: () => runSearch(true),
  isDetail: () => activeItem.value !== null,
})
</script>

<template>
  <div ref="pageEl" class="mics-page">
    <template v-if="activeItem">
      <header class="catalog-detail__header">
        <div class="catalog-detail__nav">
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            :title="`回到${entityLabel}搜索`"
            @click="goHome"
          >
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
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M9 22V12h6v10" />
            </svg>
            主页
          </button>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            @click="closeItem"
          >
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
        </div>

        <img
          v-if="activeItem.icon && !detailIconFailed"
          class="catalog-detail__icon"
          :src="activeItem.icon"
          :alt="activeItem.name"
          @error="detailIconFailed = true"
        />
        <span v-else class="catalog-detail__icon catalog-detail__icon--fallback">
          {{ activeItem.name.slice(0, 1).toUpperCase() }}
        </span>

        <div class="catalog-detail__heading">
          <div class="catalog-detail__title-row">
            <h1 class="mics-page__title">{{ activeItem.name }}</h1>
            <span class="mics-badge">{{ activeItem.sourceLabel }}</span>
          </div>
          <p class="catalog-detail__meta">
            {{ activeItem.author || '未知作者' }} · 下载 {{ formatDownloads(activeItem.downloads) }}
          </p>
          <p class="catalog-detail__summary">{{ activeItem.summary }}</p>
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
        role="radio"
        :selected-id="selectedVersionId"
        :title="versionTitle"
        :search-placeholder="versionSearchPlaceholder"
        empty-text="没有匹配的版本"
        :mono="false"
        :sort="versionSort"
        v-model:query="versionQuery"
        v-model:filter="versionFilter"
        @select="selectVersion"
      >
        <template #row="{ item }">
          <div class="mics-list__main">
            <div class="mics-list__title">
              <span>{{ item.label }}</span>
              <span
                v-if="item.badge"
                class="mics-badge"
                :class="{ 'mics-badge--accent': item.badgeAccent }"
              >
                {{ item.badge }}
              </span>
            </div>
            <div v-if="item.meta" class="mics-list__meta">{{ item.meta }}</div>
            <slot
              v-if="versionOfRow(item.id)"
              name="version-extra"
              :version="versionOfRow(item.id)"
              :selected="item.id === selectedVersionId"
            />
          </div>
          <slot
            name="version-action"
            :version="versionOfRow(item.id)"
            :selected="item.id === selectedVersionId"
          >
            <button
              v-if="item.id === selectedVersionId"
              class="mics-button mics-button--primary mics-button--small catalog-version-install"
              type="button"
              :title="`安装 ${item.label}`"
              @click.stop="openInstall"
              @keydown.enter.stop
              @keydown.space.stop
            >
              安装
            </button>
          </slot>
        </template>
      </DataBrowser>

      <BackToTop :visible="showBackToTop" @click="backToTop" />
    </template>

    <template v-else>
      <header class="mics-page__header">
        <h1 class="mics-page__title">{{ title }}</h1>
      </header>

      <div class="mics-toolbar">
        <input
          v-model="query"
          class="mics-input mics-toolbar__grow"
          type="text"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
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
      <p v-if="searchError" class="mics-notice catalog-notice--error">{{ searchError }}</p>
      <p v-else-if="sourceErrors" class="mics-notice catalog-notice--error">{{ sourceErrors }}</p>

      <div v-if="loading && !results.length" class="mics-empty">正在搜索…</div>
      <div v-else-if="!results.length" class="mics-empty">
        <template v-if="readySources.length === 0">未启用可用的{{ entityLabel }}下载源</template>
        <template v-else-if="searchError">搜索失败</template>
        <template v-else-if="sourceErrors">来源请求失败</template>
        <template v-else-if="searched">{{ emptyText }}</template>
        <template v-else>正在准备搜索…</template>
        <button
          v-if="readySources.length === 0"
          class="mics-empty__action"
          @click="emit('settings')"
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
      <div v-else class="mics-grid catalog-grid" :class="{ 'is-loading': loading }">
        <template v-for="item in results" :key="item.id">
          <slot name="card" :item="item">
            <CatalogCard :item="item" @open="openItem(item)" />
          </slot>
        </template>
      </div>

      <ListPager
        v-if="pageCount > 1"
        :page="page"
        :page-count="pageCount"
        @change="goToPage"
      />
    </template>
  </div>
</template>

<style scoped>
.catalog-grid {
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.catalog-grid.is-loading {
  opacity: 0.55;
  pointer-events: none;
}

.catalog-version-install {
  flex: none;
}

.catalog-notice--error {
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}

.catalog-detail__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px;
}

.catalog-detail__nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}

.catalog-detail__icon,
.catalog-detail__icon--fallback {
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 11px;
  object-fit: cover;
}

.catalog-detail__icon--fallback {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #4c8dff, #7c5cff);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
}

.catalog-detail__heading {
  flex: 1;
  min-width: 0;
}

.catalog-detail__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.catalog-detail__meta {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.catalog-detail__summary {
  margin: 8px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.mics-empty--error {
  color: var(--mics-danger);
}
</style>
