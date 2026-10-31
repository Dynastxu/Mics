<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { DataBrowser, defaultSelection, InstanceNameField } from '@mics/ui'
import type { FilterGroup, FilterOption, FilterSelection, ListRow } from '@mics/ui'
import { usePluginContext } from '@mics/sdk/renderer'
import { LOADER_LABELS, LOADER_SOURCE_KINDS } from '@mics/sdk'
import type {
  GameVersion,
  InstallStartResult,
  InstanceNameCheck,
  LoaderKind,
  LoaderSourceKind,
  LoaderVersion,
} from '@mics/sdk'

const ctx = usePluginContext()

type VersionType = '正式版' | '快照' | '预览' | '旧版'
type LoaderChannel = '稳定版' | '测试版'
type SortOrder = 'type' | 'newest' | 'oldest'

interface VersionItem {
  id: string
  type: VersionType
  date: string
}

interface LoaderOption {
  id: string
  label: string
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
    mode: 'single',
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
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      ...CHANNELS.map((channel) => ({ value: channel, label: channel })),
    ],
  },
]

const LOADERS: LoaderOption[] = [
  { id: 'vanilla', label: '原版' },
  ...LOADER_SOURCE_KINDS.map((kind) => ({ id: kind, label: LOADER_LABELS[kind] })),
]

const VANILLA_LOADER = LOADERS[0]!

/** 从 Mojang API 拉取的原始版本数据 */
const rawVersions = ref<GameVersion[]>([])
const versionsLoading = ref(true)
const versionsError = ref('')

/** 当前加载器可用的版本（随所选游戏版本与加载器类型查询） */
const loaderVersions = ref<LoaderVersion[]>([])
const loaderLoading = ref(false)
const loaderError = ref('')
let loaderSeq = 0

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
const nameField = ref<InstanceType<typeof InstanceNameField> | null>(null)

/** 名称可用性：本地规则即时判断，重名由主进程检查 */
const nameCheck = ref<InstanceNameCheck>({ ok: true, name: '' })

const currentLoader = computed(
  () => LOADERS.find((item) => item.id === loaderId.value) ?? VANILLA_LOADER,
)

const defaultName = computed(() => {
  const target = installTarget.value
  if (!target) return ''
  const parts = [target.id]
  if (loaderVersion.value) parts.push(currentLoader.value.label, loaderVersion.value)
  return parts.join('-')
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

function loaderChannel(channel: LoaderVersion['channel']): LoaderChannel {
  return channel === 'beta' ? '测试版' : '稳定版'
}

const loaderRows = computed<ListRow[]>(() =>
  loaderVersions.value.map((item) => ({
    id: item.id,
    label: item.id,
    badge: loaderChannel(item.channel),
    badgeAccent: item.channel !== 'beta',
    meta: item.date ? item.date.slice(0, 10) : '',
    tags: { nature: loaderChannel(item.channel) },
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

/** 主进程重名校验；本地规则由 InstanceNameField 负责 */
async function checkName(name: string): Promise<InstanceNameCheck> {
  return ctx.ipc.invoke<InstanceNameCheck>(
    'mics.download.manager',
    'install/validate-name',
    { name },
  )
}

function syncNameDraft(previousDefault: string): void {
  if (nameDraft.value === previousDefault) nameDraft.value = defaultName.value
}

/** 主进程元数据请求的超时兜底：网络挂住时页面不能一直停在加载态 */
const REQUEST_TIMEOUT = 25_000

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 查询当前加载器在目标游戏版本下可用的版本。
 *
 * 版本列表来自下载管线（下载设置里配置的加载器源），页面只负责选择；
 * 快速切换加载器时用序号丢弃过期结果。
 */
async function loadLoaderVersions(): Promise<void> {
  const target = installTarget.value
  if (!target || loaderId.value === VANILLA_LOADER.id) {
    loaderVersions.value = []
    loaderVersion.value = ''
    loaderError.value = ''
    loaderLoading.value = false
    return
  }

  const kind = loaderId.value as LoaderSourceKind
  const seq = ++loaderSeq
  const previousDefault = defaultName.value
  loaderLoading.value = true
  loaderError.value = ''
  loaderVersions.value = []
  loaderVersion.value = ''

  try {
    const list = await withTimeout(
      ctx.ipc.invoke<LoaderVersion[]>(
        'mics.download.manager',
        'loaders/versions',
        { gameVersion: target.id, kind },
      ),
      '请求超时，请检查网络或在下载设置中添加镜像源',
    )
    if (seq !== loaderSeq) return
    loaderVersions.value = list
    // 默认选稳定版；只有测试版可用时才退回第一个
    loaderVersion.value = (list.find((item) => item.channel === 'stable') ?? list[0])?.id ?? ''
    if (list.length === 0) {
      loaderError.value = `没有可用的 ${currentLoader.value.label} 版本`
    }
  } catch (cause) {
    if (seq !== loaderSeq) return
    const message = cause instanceof Error ? cause.message : String(cause)
    loaderError.value = `获取 ${currentLoader.value.label} 版本失败：${message}`
  } finally {
    if (seq === loaderSeq) {
      loaderLoading.value = false
      syncNameDraft(previousDefault)
    }
  }
}

function selectLoader(id: string): void {
  if (id === loaderId.value) {
    // 再次点击当前加载器视为重试：上次超时或列表为空时很有用
    if (id !== VANILLA_LOADER.id && !loaderLoading.value && loaderVersions.value.length === 0) {
      void loadLoaderVersions()
    }
    return
  }
  const previous = defaultName.value
  loaderId.value = id
  loaderVersions.value = []
  loaderVersion.value = ''
  loaderError.value = ''
  syncNameDraft(previous)
  void loadLoaderVersions()
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
  loaderSeq += 1
  loaderId.value = VANILLA_LOADER.id
  loaderVersion.value = ''
  loaderVersions.value = []
  loaderError.value = ''
  loaderLoading.value = false
  nameDraft.value = defaultName.value
  notice.value = ''
  noticeError.value = false
  nameCheck.value = { ok: true, name: '' }
  scrollToTop()
}

function closeInstall(): void {
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
    const loader: LoaderKind | undefined =
      loaderId.value !== VANILLA_LOADER.id ? (loaderId.value as LoaderKind) : undefined
    if (loader && !loaderVersion.value) {
      noticeError.value = true
      notice.value = '请选择加载器版本'
      return
    }

    const name = nameField.value
      ? await nameField.value.validate()
      : nameCheck.value
    if (!name.ok) {
      noticeError.value = true
      notice.value = name.message ?? '实例名称不可用'
      return
    }

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
    rawVersions.value = await withTimeout(
      ctx.ipc.invoke<GameVersion[]>('mics.download.manager', 'versions/list'),
      '请求超时，请检查网络或在下载设置中添加镜像源',
    )
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    versionsError.value = `获取版本列表失败：${message}`
  } finally {
    versionsLoading.value = false
  }
}

onMounted(loadVersions)

onUnmounted(() => {
  // 丢弃仍在途的加载器版本查询，避免组件卸载后回写状态
  loaderSeq += 1
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
            <InstanceNameField
              ref="nameField"
              v-model="nameDraft"
              class="install__name"
              label=""
              :fallback-name="defaultName"
              :check-name="checkName"
              :disabled="installing"
              @update:check="nameCheck = $event"
            />

            <button
              class="mics-button mics-button--primary install__submit"
              :disabled="installing || loaderLoading || !nameCheck.ok || (loaderId !== VANILLA_LOADER.id && !loaderVersion)"
              @click="install"
            >
              {{ installing ? '提交中…' : '安装' }}
            </button>
          </div>
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

      <div v-if="loaderLoading" class="mics-empty">正在获取加载器版本…</div>
      <div v-else-if="loaderError" class="mics-empty mics-empty--error">
        {{ loaderError }}
        <button class="mics-empty__action" @click="loadLoaderVersions">重试</button>
      </div>

      <DataBrowser
        v-else-if="loaderRows.length"
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
      <div v-else-if="versionsError" class="mics-empty mics-empty--error">
        {{ versionsError }}
        <button class="mics-empty__action" @click="loadVersions">重试</button>
      </div>

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