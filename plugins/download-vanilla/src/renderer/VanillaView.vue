<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { DataBrowser, defaultSelection } from '@mics/ui'
import type { FilterGroup, FilterOption, FilterSelection, ListRow } from '@mics/ui'
import { usePluginContext } from '@mics/sdk/renderer'
import { sanitizeInstanceName, validateInstanceName } from '@mics/sdk'
import type { GameVersion, InstallStartResult, InstanceNameCheck, LoaderKind } from '@mics/sdk'

const ctx = usePluginContext()

type VersionType = '正式版' | '快照' | '预览' | '旧版'
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
  versions: LoaderVersion[]
}

const VERSION_TYPES: VersionType[] = ['正式版', '快照', '预览', '旧版']
const TYPE_RANK: Record<VersionType, number> = { 正式版: 0, 快照: 1, 预览: 2, 旧版: 3 }

const CHANNELS: LoaderChannel[] = ['稳定版', '测试版']
const CHANNEL_RANK: Record<LoaderChannel, number> = { 稳定版: 0, 测试版: 1 }

const SORTS: FilterOption[] = [
  { value: 'type', label: '按类型' },
  { value: 'newest', label: '最新发布' },
  { value: 'oldest', label: '最早发布' },
]

const SORT_GROUP: FilterGroup = {
  key: 'sort',
  label: '排序方式',
  mode: 'single',
  affects: 'order',
  options: SORTS,
}

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

/** 从 Mojang API 拉取的原始版本数据 */
const rawVersions = ref<GameVersion[]>([])
const versionsLoading = ref(true)
const versionsError = ref('')

const listQuery = ref('')
const listFilter = ref<FilterSelection>(defaultSelection(LIST_FILTER_GROUPS))
const notice = ref('')
const noticeError = ref(false)
const installing = ref(false)

const pageEl = ref<HTMLElement | null>(null)

const installTarget = ref<VersionItem | null>(null)
const loaderId = ref(VANILLA_LOADER.id)
const loaderVersion = ref('')
const nameDraft = ref('')

/** 名称可用性：本地规则即时判断，重名由主进程检查 */
const nameCheck = ref<InstanceNameCheck>({ ok: true, name: '' })
let nameCheckTimer: ReturnType<typeof setTimeout> | null = null
let nameCheckSeq = 0

const currentLoader = computed(
  () => LOADERS.find((item) => item.id === loaderId.value) ?? VANILLA_LOADER,
)
const allLoaderVersions = computed(() => currentLoader.value.versions)

const defaultName = computed(() => {
  const target = installTarget.value
  if (!target) return ''
  const parts = [target.id]
  if (loaderVersion.value) parts.push(currentLoader.value.label, loaderVersion.value)
  return parts.join('-')
})

const effectiveName = computed(() => {
  const custom = nameDraft.value.trim().replace(/[. ]+$/, '')
  return custom || defaultName.value
})

/** Mojang type -> 中文类型 */
function mapType(type: GameVersion['type']): VersionType {
  switch (type) {
    case 'release': return '正式版'
    case 'snapshot': return '快照'
    case 'old_alpha':
    case 'old_beta': return '旧版'
    default: return '快照'
  }
}

/** 原始版本 -> 列表行 */
const VERSION_ROWS = computed<ListRow[]>(() =>
  rawVersions.value.map((version) => ({
    id: version.id,
    label: version.id,
    badge: mapType(version.type),
    badgeAccent: version.type === 'release',
    meta: version.releaseTime.slice(0, 10),
    tags: { nature: mapType(version.type) },
  })),
)

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

function versionSearchText(row: ListRow): string {
  return row.label
}

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

const versionSort = bySort(
  (row) => TYPE_RANK[(row.badge ?? '') as VersionType] ?? 0,
)
const loaderSort = bySort(
  (row) => CHANNEL_RANK[(row.badge ?? '') as LoaderChannel] ?? 0,
)

/**
 * 校验当前名称：本地规则先给结论，再问主进程是否重名。
 * 返回最终结论，提交前可以直接用。
 */
async function runNameCheck(): Promise<InstanceNameCheck> {
  const seq = ++nameCheckSeq
  const local = validateInstanceName(effectiveName.value)
  if (!local.ok) {
    nameCheck.value = local
    return local
  }

  try {
    const remote = await ctx.ipc.invoke<InstanceNameCheck>(
      'mics.download.manager',
      'install/validate-name',
      { name: local.name },
    )
    if (seq === nameCheckSeq) nameCheck.value = remote
    return remote
  } catch {
    // 主进程查询失败时先按本地规则放行，提交时主进程仍会把关
    if (seq === nameCheckSeq) nameCheck.value = local
    return local
  }
}

function scheduleNameCheck(delay = 220): void {
  if (nameCheckTimer) clearTimeout(nameCheckTimer)
  nameCheckTimer = setTimeout(() => {
    nameCheckTimer = null
    void runNameCheck()
  }, delay)
}

function onNameInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const sanitized = sanitizeInstanceName(input.value)
  if (sanitized !== input.value) {
    const caret = Math.max(0, (input.selectionStart ?? 0) - (input.value.length - sanitized.length))
    input.value = sanitized
    input.setSelectionRange(caret, caret)
  }
  nameDraft.value = sanitized
  scheduleNameCheck()
}

function normalizeName(): void {
  nameDraft.value = nameDraft.value.trim().replace(/[. ]+$/, '')
}

function onNameBlur(): void {
  normalizeName()
  void runNameCheck()
}

function syncNameDraft(previousDefault: string): void {
  if (nameDraft.value === previousDefault) {
    nameDraft.value = defaultName.value
    scheduleNameCheck()
  }
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
  const version = VERSION_ROWS.value.find((item) => item.id === id)
  if (!version) return
  installTarget.value = { id: version.id, type: version.badge as VersionType, date: version.meta ?? '' }
  loaderId.value = VANILLA_LOADER.id
  loaderVersion.value = ''
  nameDraft.value = defaultName.value
  notice.value = ''
  noticeError.value = false
  nameCheck.value = { ok: true, name: '' }
  scheduleNameCheck(0)
  scrollToTop()
}

function closeInstall(): void {
  if (nameCheckTimer) {
    clearTimeout(nameCheckTimer)
    nameCheckTimer = null
  }
  installTarget.value = null
  notice.value = ''
  noticeError.value = false
  scrollToTop()
}

async function install(): Promise<void> {
  const target = installTarget.value
  if (!target || installing.value) return
  installing.value = true
  notice.value = ''
  noticeError.value = false

  try {
    const name = await runNameCheck()
    if (!name.ok) {
      noticeError.value = true
      notice.value = name.message ?? '实例名称不可用'
      return
    }

    const loader: LoaderKind | undefined =
      loaderId.value !== 'vanilla' ? (loaderId.value as LoaderKind) : undefined

    const result = await ctx.ipc.invoke<InstallStartResult>(
      'mics.download.manager',
      'install/start',
      {
        gameVersion: target.id,
        instanceName: name.name,
        ...(loader && loaderVersion.value
          ? { loader: { kind: loader, version: loaderVersion.value } }
          : {}),
      },
    )

    if (result.error) {
      noticeError.value = true
      notice.value = `安装失败：${result.error}`
      return
    }

    // 受理后直接进入下载页；下载清单在后台准备，不再在这里回显任务 id
    if (ctx.ui.navigate('download.progress')) return

    // 下载页不可用（插件被禁用）时留在当前页给出提示
    notice.value = `「${name.name}」已加入下载队列。`
    scheduleNameCheck(0)
  } catch (cause) {
    noticeError.value = true
    notice.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    installing.value = false
  }
}

async function loadVersions(): Promise<void> {
  versionsLoading.value = true
  versionsError.value = ''
  try {
    rawVersions.value = await ctx.ipc.invoke<GameVersion[]>(
      'mics.download.vanilla',
      'versions/list',
    )
  } catch (cause) {
    versionsError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    versionsLoading.value = false
  }
}

onMounted(loadVersions)

onUnmounted(() => {
  if (nameCheckTimer) clearTimeout(nameCheckTimer)
})
</script>

<template>
  <div ref="pageEl" class="mics-page">
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

        <div class="install__actions">
          <div class="install__row">
            <input
              class="mics-input install__name"
              :class="{ 'is-invalid': !nameCheck.ok }"
              type="text"
              :value="nameDraft"
              :placeholder="defaultName"
              aria-label="实例名称"
              :aria-invalid="!nameCheck.ok"
              :aria-describedby="nameCheck.ok ? undefined : 'install-name-error'"
              spellcheck="false"
              @input="onNameInput"
              @blur="onNameBlur"
            />

            <button
              class="mics-button mics-button--primary install__submit"
              :disabled="installing || !nameCheck.ok"
              @click="install"
            >
              {{ installing ? '提交中…' : '安装' }}
            </button>
          </div>

          <p v-if="!nameCheck.ok" id="install-name-error" class="install__name-error">
            {{ nameCheck.message }}
          </p>
        </div>
      </header>

      <p v-if="notice" class="mics-notice" :class="{ 'mics-notice--error': noticeError }">
        {{ notice }}
      </p>

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

    <template v-else>
      <header class="mics-page__header">
        <h1 class="mics-page__title">原版</h1>
      </header>

      <div v-if="versionsLoading" class="mics-empty">正在获取版本列表…</div>
      <div v-else-if="versionsError" class="mics-empty mics-empty--error">{{ versionsError }}</div>

      <DataBrowser
        v-else
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

.install__actions {
  display: flex;
  flex: 0 1 350px;
  flex-direction: column;
  gap: 4px;
  min-width: 232px;
  margin-left: auto;
}

.install__row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.install__name {
  flex: 1 1 260px;
  min-width: 140px;
}

.install__name.is-invalid {
  border-color: var(--mics-danger);
}

.install__name-error {
  margin: 0;
  color: var(--mics-danger);
  font-size: 11px;
  line-height: 1.4;
}

.install__submit {
  flex: none;
}

.install__meta {
  margin: 2px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.mics-notice--error {
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}

.mics-empty--error {
  color: var(--mics-accent, #ef4444);
}
</style>