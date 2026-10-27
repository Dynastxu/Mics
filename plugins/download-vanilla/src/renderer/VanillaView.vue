<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { DataBrowser, defaultSelection } from '@mics/ui'
import type { FilterGroup, FilterOption, FilterSelection, ListRow } from '@mics/ui'

type VersionType = '正式版' | '快照' | '预览'
type LoaderChannel = '稳定版' | '测试版'
type SortOrder = 'type' | 'newest' | 'oldest'

interface VersionItem {
  id: string
  type: VersionType
  date: string
}

interface LoaderVersion {
  id: string
  channel: LoaderChannel
  date: string
}

interface LoaderOption {
  id: string
  label: string
  /** 原版没有加载器版本 */
  versions: LoaderVersion[]
}

const VERSIONS: VersionItem[] = [
  { id: '1.21.5', type: '正式版', date: '2025-03-25' },
  { id: '1.21.4', type: '正式版', date: '2024-12-03' },
  { id: '1.21.1', type: '正式版', date: '2024-08-08' },
  { id: '1.20.6', type: '正式版', date: '2024-04-29' },
  { id: '1.20.1', type: '正式版', date: '2023-06-12' },
  { id: '25w14a', type: '快照', date: '2025-04-02' },
  { id: '25w10a', type: '快照', date: '2025-03-05' },
  { id: '1.21.6-pre1', type: '预览', date: '2025-04-15' },
]

const VERSION_TYPES: VersionType[] = ['正式版', '快照', '预览']
const TYPE_RANK: Record<VersionType, number> = { 正式版: 0, 快照: 1, 预览: 2 }

const CHANNELS: LoaderChannel[] = ['稳定版', '测试版']
const CHANNEL_RANK: Record<LoaderChannel, number> = { 稳定版: 0, 测试版: 1 }

const SORTS: FilterOption[] = [
  { value: 'type', label: '按类型' },
  { value: 'newest', label: '最新发布' },
  { value: 'oldest', label: '最早发布' },
]

/** 两个列表共用的排序组：只影响排序，不参与行过滤 */
const SORT_GROUP: FilterGroup = {
  key: 'sort',
  label: '排序方式',
  mode: 'single',
  affects: 'order',
  options: SORTS,
}

/** 列表页：排序方式 + 游戏版本性质 */
const LIST_FILTER_GROUPS: FilterGroup[] = [
  SORT_GROUP,
  {
    key: 'nature',
    label: '版本性质',
    mode: 'multi',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...VERSION_TYPES.map((type) => ({ value: type, label: type })),
    ],
  },
]

/** 安装页：排序方式 + 加载器版本性质 */
const LOADER_FILTER_GROUPS: FilterGroup[] = [
  SORT_GROUP,
  {
    key: 'nature',
    label: '版本性质',
    mode: 'multi',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...CHANNELS.map((channel) => ({ value: channel, label: channel })),
    ],
  },
]

const VANILLA_LOADER: LoaderOption = { id: 'vanilla', label: '原版', versions: [] }

const LOADERS: LoaderOption[] = [
  VANILLA_LOADER,
  {
    id: 'fabric',
    label: 'Fabric',
    versions: [
      { id: '0.16.10', channel: '稳定版', date: '2025-03-18' },
      { id: '0.16.9', channel: '稳定版', date: '2025-02-27' },
      { id: '0.16.5', channel: '稳定版', date: '2025-01-08' },
      { id: '0.16.11-beta.1', channel: '测试版', date: '2025-04-05' },
    ],
  },
  {
    id: 'forge',
    label: 'Forge',
    versions: [
      { id: '55.0.3', channel: '稳定版', date: '2025-04-08' },
      { id: '55.0.2', channel: '稳定版', date: '2025-03-21' },
      { id: '55.0.1', channel: '稳定版', date: '2025-03-02' },
      { id: '55.0.4-beta', channel: '测试版', date: '2025-04-12' },
    ],
  },
  {
    id: 'neoforge',
    label: 'NeoForge',
    versions: [
      { id: '21.5.78', channel: '稳定版', date: '2025-04-11' },
      { id: '21.5.75', channel: '稳定版', date: '2025-03-28' },
      { id: '21.5.60', channel: '稳定版', date: '2025-02-19' },
      { id: '21.5.79-beta', channel: '测试版', date: '2025-04-18' },
    ],
  },
]

/** 列表页的搜索与筛选：受控保存，进出安装页后仍保持 */
const listQuery = ref('')
const listFilter = ref<FilterSelection>(defaultSelection(LIST_FILTER_GROUPS))
const notice = ref('')

/** 页面根节点：切换列表/安装页时把滚动位置带回顶部 */
const pageEl = ref<HTMLElement | null>(null)

/** 当前打开的安装页；null 时显示版本列表 */
const installTarget = ref<VersionItem | null>(null)
const loaderId = ref(VANILLA_LOADER.id)
const loaderVersion = ref('')
/** 版本名称（选择指纹）；为空时回退到默认值 */
const nameDraft = ref('')

const currentLoader = computed(
  () => LOADERS.find((item) => item.id === loaderId.value) ?? VANILLA_LOADER,
)
const allLoaderVersions = computed(() => currentLoader.value.versions)

/** 默认版本名称：原版版本-加载器-加载器版本 */
const defaultName = computed(() => {
  const target = installTarget.value
  if (!target) return ''
  const parts = [target.id]
  if (loaderVersion.value) parts.push(currentLoader.value.label, loaderVersion.value)
  return parts.join('-')
})

/** 实际使用的名称：自填优先，为空回退到默认指纹 */
const effectiveName = computed(() => {
  const custom = nameDraft.value.trim().replace(/[. ]+$/, '')
  return custom || defaultName.value
})

/** 列表页的行数据；nature 供「版本性质」筛选匹配 */
const VERSION_ROWS: ListRow[] = VERSIONS.map((version) => ({
  id: version.id,
  label: version.id,
  badge: version.type,
  badgeAccent: version.type === '正式版',
  meta: version.date,
  tags: { nature: version.type },
}))

/** 安装页的行数据 */
const loaderRows = computed<ListRow[]>(() =>
  allLoaderVersions.value.map((item) => ({
    id: item.id,
    label: item.id,
    badge: item.channel,
    badgeAccent: item.channel === '稳定版',
    meta: item.date,
    tags: { nature: item.channel },
  })),
)

/** 搜索只匹配版本号，与改造前一致 */
function versionSearchText(row: ListRow): string {
  return row.label
}

/** 排序规则：先按性质分组或直接按日期，列表页与安装页共用 */
function bySort(rank: (row: ListRow) => number) {
  return (a: ListRow, b: ListRow, selection: FilterSelection): number => {
    const order = (selection.sort?.[0] as SortOrder) ?? 'type'
    if (order === 'type') {
      return rank(a) - rank(b) || (b.meta ?? '').localeCompare(a.meta ?? '')
    }
    const byDate =
      order === 'newest'
        ? (b.meta ?? '').localeCompare(a.meta ?? '')
        : (a.meta ?? '').localeCompare(b.meta ?? '')
    return byDate || rank(a) - rank(b) || a.label.localeCompare(b.label)
  }
}

const versionSort = bySort((row) => TYPE_RANK[(row.badge ?? '') as VersionType] ?? 0)
const loaderSort = bySort((row) => CHANNEL_RANK[(row.badge ?? '') as LoaderChannel] ?? 0)

/** Windows 文件夹名不支持的字符：输入时直接剔除 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

function onNameInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const sanitized = input.value.replace(INVALID_NAME_CHARS, '')
  if (sanitized !== input.value) {
    const caret = Math.max(0, (input.selectionStart ?? 0) - (input.value.length - sanitized.length))
    input.value = sanitized
    input.setSelectionRange(caret, caret)
  }
  nameDraft.value = sanitized
}

function normalizeName(): void {
  nameDraft.value = nameDraft.value.trim().replace(/[. ]+$/, '')
}

/** 选择变化时，只有未手动改过的名称才跟着更新 */
function syncNameDraft(previousDefault: string): void {
  if (nameDraft.value === previousDefault) nameDraft.value = defaultName.value
}

function selectLoader(id: string): void {
  const previous = defaultName.value
  loaderId.value = id
  loaderVersion.value = LOADERS.find((item) => item.id === id)?.versions[0]?.id ?? ''
  syncNameDraft(previous)
}

function selectVersion(id: string): void {
  const previous = defaultName.value
  loaderVersion.value = id
  syncNameDraft(previous)
}

function scrollToTop(): void {
  void nextTick(() => pageEl.value?.scrollIntoView({ block: 'start' }))
}

function openInstall(id: string): void {
  const version = VERSIONS.find((item) => item.id === id)
  if (!version) return
  installTarget.value = version
  loaderId.value = VANILLA_LOADER.id
  loaderVersion.value = ''
  nameDraft.value = defaultName.value
  notice.value = ''
  scrollToTop()
}

function closeInstall(): void {
  installTarget.value = null
  notice.value = ''
  scrollToTop()
}

function install(): void {
  if (!installTarget.value) return
  notice.value = `「${effectiveName.value}」的安装流程尚未接入。`
}
</script>

<template>
  <div ref="pageEl" class="mics-page">
    <!-- 安装页：列表里点一下版本进来，左上角返回 -->
    <template v-if="installTarget">
      <header class="install__header">
        <button class="mics-button mics-button--ghost mics-button--small" @click="closeInstall">
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

        <div>
          <div class="install__title">
            <h1 class="mics-page__title">{{ installTarget.id }}</h1>
            <span
              class="mics-badge"
              :class="{ 'mics-badge--accent': installTarget.type === '正式版' }"
            >
              {{ installTarget.type }}
            </span>
          </div>
          <p class="install__meta">{{ installTarget.date }}</p>
        </div>

        <input
          class="mics-input install__name"
          type="text"
          :value="nameDraft"
          :placeholder="defaultName"
          aria-label="版本名称"
          spellcheck="false"
          @input="onNameInput"
          @blur="normalizeName"
        />

        <button class="mics-button mics-button--primary install__submit" @click="install">
          安装
        </button>
      </header>

      <p v-if="notice" class="mics-notice">{{ notice }}</p>

      <section class="mics-section">
        <h2 class="mics-section__title">模组加载器</h2>
        <div class="mics-chips" role="radiogroup" aria-label="模组加载器">
          <button
            v-for="option in LOADERS"
            :key="option.id"
            class="mics-chip"
            :class="{ 'is-active': loaderId === option.id }"
            role="radio"
            :aria-checked="loaderId === option.id"
            @click="selectLoader(option.id)"
          >
            {{ option.label }}
          </button>
        </div>
      </section>

      <!-- 加载器版本：行样式与筛选都跟原版版本列表一致 -->
      <DataBrowser
        v-if="allLoaderVersions.length"
        :items="loaderRows"
        :groups="LOADER_FILTER_GROUPS"
        title="加载器版本"
        :searchable="false"
        role="radio"
        :selected-id="loaderVersion"
        :sort="loaderSort"
        @select="selectVersion"
      />
    </template>

    <!-- 版本列表 -->
    <template v-else>
      <header class="mics-page__header">
        <h1 class="mics-page__title">原版</h1>
      </header>

      <DataBrowser
        :items="VERSION_ROWS"
        :groups="LIST_FILTER_GROUPS"
        title="版本"
        search-placeholder="搜索版本号"
        action-label="安装"
        :search-text="versionSearchText"
        :sort="versionSort"
        v-model:query="listQuery"
        v-model:filter="listFilter"
        @select="openInstall"
      />
    </template>
  </div>
</template>

<style scoped>
.install__header {
  display: flex;
  align-items: center;
  gap: 14px;
}

.install__title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.install__name {
  flex: 0 1 260px;
  min-width: 140px;
  margin-left: auto;
}

.install__submit {
  flex: none;
}

.install__meta {
  margin: 2px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12px;
}
</style>
