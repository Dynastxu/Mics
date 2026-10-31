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
  ModDependency,
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

/** 页面真正的滚动容器（shell 的 .mics-main__page）；挂载后缓存，用于监听滚动 */
let pageScrollEl: HTMLElement | null = null
const showBackToTop = ref(false)

/** 页面滚过一屏左右才显示悬浮按钮，避免首屏就挡住内容 */
const BACK_TO_TOP_THRESHOLD = 240

function onPageScroll(): void {
  showBackToTop.value = (pageScrollEl?.scrollTop ?? 0) > BACK_TO_TOP_THRESHOLD
}

function backToTop(): void {
  const container = pageScrollEl ?? pageScrollParent()
  if (container) container.scrollTo({ top: 0, behavior: 'smooth' })
  else scrollToTop()
}

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
/** 版本行是单选列表：点击只选中，安装由选中行右侧的按钮触发 */
const selectedVersionId = ref('')

const installOpen = ref(false)
const installVersion = ref<ModVersion | null>(null)

/** 一个 Mod 详情页的浏览现场：返回上一层时要原样恢复，用户才能接着操作 */
interface ModViewSnapshot {
  mod: ModSummary
  filter: FilterSelection
  query: string
  selectedVersionId: string
  /** 离开时的页面滚动位置（shell 的 .mics-main__page） */
  scrollTop: number
}

/**
 * 从「前置」跳转过来的历史。
 *
 * 返回时不能只回到项目：筛选、版本搜索词、选中的版本和滚动位置都要恢复，
 * 否则用户在长列表里刚选好的版本会丢失。
 */
const modHistory = ref<ModViewSnapshot[]>([])

/** 返回上一层时待恢复的滚动位置；版本列表渲染后消费一次 */
let pendingScrollTop: number | null = null

/** 从搜索结果进入详情时的滚动位置；彻底关闭详情后恢复，不用重新往下翻 */
let searchScrollTop = 0

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

/** 当前选中的版本；列表被筛选隐藏时仍然保留，安装按钮依旧可用 */
const selectedVersion = computed(
  () => versions.value.find((version) => version.id === selectedVersionId.value) ?? null,
)

/** 每个版本行的必装前置；只有选中的那一行会渲染成按钮 */
const requiredDependencies = computed(() => {
  const map = new Map<string, ModDependency[]>()
  for (const version of versions.value) {
    const dependencies = (version.dependencies ?? [])
      .filter((dependency) => dependency.kind === 'required' && dependency.name)
    if (dependencies.length > 0) map.set(version.id, dependencies)
  }
  return map
})

function rowDependencies(id: string): ModDependency[] {
  return requiredDependencies.value.get(id) ?? []
}

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

/** 前置名称参与版本搜索；匹配「Fabric API」可以找到需要它的版本 */
function requiredDependencyNames(version: ModVersion): string[] {
  return (version.dependencies ?? [])
    .filter((dependency) => dependency.kind === 'required')
    .map((dependency) => dependency.name)
    .filter(Boolean)
}

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
      ...requiredDependencyNames(version),
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

  let loaded = false
  try {
    const list = await ctx.ipc.invoke<ModVersion[]>(
      'mics.download.manager',
      'mods/versions',
      request,
    )
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
        // 没有待恢复的滚动位置（例如失败后重试）时，至少保证选中行可见
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

function intentFilter(intent: ModOpenIntent): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  if (intent.gameVersion) filter.gameVersion = [intent.gameVersion]
  if (intent.loader && intent.loader !== 'all') filter.loader = [intent.loader]
  return filter
}

/** 前置跳转保留当前的 MC 版本 / 加载器筛选，方便直接挑对应版本的依赖 */
function dependencyFilter(): FilterSelection {
  const filter: FilterSelection = { sort: ['newest'] }
  const gameVersion = versionFilter.value.gameVersion?.[0]
  if (gameVersion && gameVersion !== 'all') filter.gameVersion = [gameVersion]
  const loader = versionFilter.value.loader?.[0]
  if (loader && loader !== 'all') filter.loader = [loader]
  return filter
}

/** 页面真正的滚动容器是 shell 的 .mics-main__page，而不是 mics-page 本身 */
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

/** 离开一个 Mod 详情页时记录浏览现场，返回时原样恢复 */
function snapshotMod(mod: ModSummary): ModViewSnapshot {
  return {
    mod,
    filter: { ...versionFilter.value },
    query: versionQuery.value,
    selectedVersionId: selectedVersionId.value,
    scrollTop: pageScrollParent()?.scrollTop ?? 0,
  }
}

/**
 * 补项目作者。
 *
 * 版本列表 / 指纹识别里的项目摘要不含作者（Modrinth 的作者在团队信息里），
 * 打开详情后单独查一次；查不到只影响作者这一行，不影响页面其它内容。
 */
async function hydrateAuthor(mod: ModSummary): Promise<void> {
  if (mod.author) return
  try {
    const summary = await ctx.ipc.invoke<ModSummary>(
      'mics.download.manager',
      'mods/project',
      {
        source: mod.source,
        ...(mod.sourceApi ? { sourceApi: mod.sourceApi } : {}),
        projectId: mod.projectId,
      },
    )
    // 用户可能已经返回或跳到别的 Mod，只有还停在这个项目时才更新
    if (activeMod.value?.id === mod.id) activeMod.value = summary
  } catch {
    // 作者只是展示信息，查不到就保持原样
  }
}

function openMod(mod: ModSummary, initialFilter = searchFilter(), remember = false): void {
  if (remember && activeMod.value) {
    modHistory.value.push(snapshotMod(activeMod.value))
  }
  // 从搜索结果进入详情前记下滚动位置；从另一个详情跳过来时保持原值
  if (!activeMod.value) searchScrollTop = pageScrollParent()?.scrollTop ?? 0
  pendingScrollTop = null
  showBackToTop.value = false
  activeMod.value = mod
  selectedVersionId.value = ''
  versionQuery.value = ''
  // 详情筛选的选择项仍来自全部版本；初始值来自搜索页或实例上下文。
  versionFilter.value = initialFilter
  installOpen.value = false
  installVersion.value = null
  void loadVersions()
  void hydrateAuthor(mod)
  scrollToTop()
}

/** 返回上一层：恢复筛选、版本搜索词、选中的版本与滚动位置 */
function restoreMod(snapshot: ModViewSnapshot): void {
  activeMod.value = snapshot.mod
  versionQuery.value = snapshot.query
  versionFilter.value = snapshot.filter
  selectedVersionId.value = snapshot.selectedVersionId
  installOpen.value = false
  installVersion.value = null
  pendingScrollTop = snapshot.scrollTop
  void loadVersions()
  void hydrateAuthor(snapshot.mod)
}

/**
 * 恢复离开前的滚动位置。
 *
 * 列表刚挂载时高度可能还会变一帧；内容没撑开就先别设 scrollTop
 * （否则会被钳成 0），等下一帧再试。设好后再检查选中行是否在视野内。
 */
function restoreScroll(top: number): void {
  const apply = (attempt: number): void => {
    const container = pageScrollParent()
    if (!container) {
      if (attempt < 3) {
        requestAnimationFrame(() => apply(attempt + 1))
        return
      }
      // 极端情况下找不到滚动容器，至少保证选中行可见
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

/** 彻底回到搜索结果：清空前置跳转的历史，保留搜索页自己的状态与滚动位置 */
function closeToSearch(): void {
  versionSeq += 1
  installOpen.value = false
  installVersion.value = null
  pendingScrollTop = null
  modHistory.value = []
  activeMod.value = null
  versions.value = []
  versionError.value = ''
  selectedVersionId.value = ''

  // 搜索结果列表重新挂载后再恢复滚动位置
  const top = searchScrollTop
  void nextTick(() => {
    const container = pageScrollParent()
    if (container) container.scrollTop = top
  })
}

/** 左上角「主页」：不经过前置返回栈，直接回到 Mod 搜索页 */
function goHome(): void {
  closeToSearch()
}

function closeMod(): void {
  // 从「前置」跳转进来的，先退回上一个 Mod；否则回到搜索结果
  const previous = modHistory.value.pop()
  if (!previous) {
    closeToSearch()
    return
  }

  versionSeq += 1
  installOpen.value = false
  installVersion.value = null
  restoreMod(previous)
}

/** 点击版本行只选中；安装按钮在选中行右侧，点击后才打开实例选择 */
function selectVersion(id: string): void {
  selectedVersionId.value = id
}

function openInstall(): void {
  const version = selectedVersion.value
  if (!version) return
  installVersion.value = version
  installOpen.value = true
}

function openDependency(dependency: ModDependency): void {
  const project = dependency.project
  if (!project) return
  openMod(project, dependencyFilter(), true)
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

onMounted(() => {
  // 页面滚动由 shell 的 .mics-main__page 承担，mics-page 本身不滚动
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
</script>

<template>
  <div ref="pageEl" class="mics-page">
    <template v-if="activeMod">
      <header class="mod-detail__header">
        <div class="mod-detail__nav">
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            title="回到 Mod 搜索"
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
            @click="closeMod"
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
        role="radio"
        :selected-id="selectedVersionId"
        title="版本"
        search-placeholder="搜索版本"
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
            <div
              v-if="item.id === selectedVersionId && rowDependencies(item.id).length"
              class="version-deps"
            >
              <span class="version-deps__label">前置</span>
              <button
                v-for="dependency in rowDependencies(item.id)"
                :key="`${dependency.projectId}:${dependency.name}`"
                class="version-deps__chip"
                type="button"
                :disabled="!dependency.project"
                :title="dependency.project ? `打开 ${dependency.name}` : undefined"
                @click.stop="openDependency(dependency)"
                @keydown.enter.stop
                @keydown.space.stop
              >
                {{ dependency.name }}
                <span v-if="dependency.project" class="version-deps__arrow" aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
          <button
            v-if="item.id === selectedVersionId"
            class="mics-button mics-button--primary mics-button--small version-install"
            type="button"
            :title="`安装 ${item.label}`"
            @click.stop="openInstall"
            @keydown.enter.stop
            @keydown.space.stop
          >
            安装
          </button>
        </template>
      </DataBrowser>

      <button
        v-if="showBackToTop"
        class="mod-backtop"
        type="button"
        title="返回顶部"
        aria-label="返回顶部"
        @click="backToTop"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m6 14 6-6 6 6" />
        </svg>
      </button>
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

.version-install {
  flex: none;
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

.mod-detail__nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
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

/* 详情页右下角的悬浮「返回顶部」；底部留出 26px 状态栏 */
.mod-backtop {
  position: fixed;
  right: 24px;
  bottom: 42px;
  z-index: 40;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--mics-border);
  border-radius: 50%;
  background: color-mix(in srgb, var(--mics-bg-elevated) 92%, transparent);
  color: var(--mics-fg-muted);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  backdrop-filter: blur(8px);
  transition: color 0.12s ease, border-color 0.12s ease;
}

.mod-backtop:hover {
  border-color: var(--mics-accent);
  color: var(--mics-accent);
}

.mod-backtop:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 2px;
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
