<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { MOD_OPEN_INTENT_KEY } from '@mics/sdk'
import type { ModIdentity, ModLoader, ModOpenIntent } from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'
import { ToggleSwitch } from '@mics/ui'
import type {
  InstanceArea,
  InstanceDetail,
  InstanceLogContent,
  InstanceLogFile,
  InstanceModEntry,
  InstanceMods,
  InstanceSummary,
  InstanceUsage,
  InstanceUsageEntry,
  LaunchProcessInfo,
} from '../shared'
import DeleteInstanceDialog from './DeleteInstanceDialog.vue'
import DeleteModDialog from './DeleteModDialog.vue'

const props = defineProps<{
  instance: InstanceSummary
  processes: LaunchProcessInfo[]
  starting: boolean
  /** 启动页汇总的安装阶段：下载中 / 已暂停 / 不完整 */
  installPhase: 'ready' | 'downloading' | 'paused' | 'incomplete'
  canLaunch: boolean
  /** 已有可用账户；没有账户时启动按钮禁用 */
  accountReady: boolean
  repairing: boolean
}>()

const emit = defineEmits<{
  back: []
  play: []
  terminate: []
  repair: []
  deleted: [id: string]
  /** 启用的 Mod 数量变化，用于更新返回列表后的徽标 */
  changed: [mods: number]
}>()

type DetailTab = 'overview' | 'logs' | 'mods'

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'logs', label: '日志' },
  { id: 'mods', label: 'Mod' },
]

const USAGE_LABELS: Record<string, string> = {
  '.': '根目录文件',
  versions: '版本与依赖',
  libraries: '依赖库',
  assets: '游戏资源',
  mods: 'Mod',
  saves: '存档',
  logs: '日志',
  config: '配置',
  resourcepacks: '资源包',
  shaderpacks: '光影包',
  screenshots: '截图',
  'crash-reports': '崩溃报告',
  defaultconfigs: '默认配置',
}

const ACCENTS = ['', 'mics-avatar--amber', 'mics-avatar--teal', 'mics-avatar--rose']

const ctx = usePluginContext()

const tab = ref<DetailTab>('overview')
const detail = ref<InstanceDetail | null>(null)
const loading = ref(true)
const error = ref('')
const notice = ref('')

const usage = ref<InstanceUsage | null>(null)
const usageLoading = ref(false)
const copied = ref(false)

const logFiles = ref<InstanceLogFile[]>([])
const logName = ref('')
const logContent = ref<InstanceLogContent | null>(null)
const logsLoading = ref(false)
const logLoading = ref(false)
const logsError = ref('')
const logView = ref<HTMLElement | null>(null)

const mods = ref<InstanceMods | null>(null)
const modsLoading = ref(false)
const modsError = ref('')
const modQuery = ref('')
const modBusy = ref('')
const modDeleteTarget = ref<InstanceModEntry | null>(null)
const modDeleting = ref(false)
const brokenModIcons = ref<Record<string, boolean>>({})

const deleteOpen = ref(false)
const deleting = ref(false)

let logsLoaded = false
let modsLoaded = false
let logSequence = 0
let identifySequence = 0

const alive = computed(() => props.processes.length > 0)
const statusLabel = computed(() => {
  if (props.installPhase === 'downloading') return '下载中'
  if (props.installPhase === 'paused') return '已暂停'
  if (props.installPhase === 'incomplete') return '不完整'
  if (props.starting) return '启动中'
  if (alive.value) return `运行中 · ${props.processes.length}`
  return '未运行'
})

const avatarClass = computed(() => {
  const index = hashString(props.instance.id) % ACCENTS.length
  return ACCENTS[index] ?? ''
})

const usageRows = computed(() => usage.value?.entries.slice(0, 8) ?? [])
const usageHiddenCount = computed(() =>
  Math.max(0, (usage.value?.entries.length ?? 0) - usageRows.value.length),
)

const modCount = computed(() => mods.value?.entries.length ?? 0)
const enabledModCount = computed(
  () => mods.value?.entries.filter((entry) => entry.enabled).length ?? 0,
)
const filteredMods = computed(() => {
  const entries = mods.value?.entries ?? []
  const query = modQuery.value.trim().toLowerCase()
  if (!query) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(query))
})

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function hashString(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0
  }
  return Math.abs(hash)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[index] ?? 'B'}`
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '从未'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function usageLabel(name: string): string {
  return USAGE_LABELS[name] ?? name
}

function usagePercent(entry: InstanceUsageEntry): number {
  const total = usage.value?.total ?? 0
  if (total <= 0 || entry.size <= 0) return 0
  return Math.min(100, Math.max(1, Math.round((entry.size / total) * 100)))
}

function goBack(): void {
  emit('back')
}

function selectTab(id: DetailTab): void {
  tab.value = id
}

function closeDeleteDialog(): void {
  deleteOpen.value = false
}

function requestPlay(): void {
  emit('play')
}

function requestTerminate(): void {
  emit('terminate')
}

function askDelete(): void {
  notice.value = ''
  deleteOpen.value = true
}

async function loadDetail(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    detail.value = await ctx.ipc.invoke<InstanceDetail>('mics.launch', 'instances/detail', {
      id: props.instance.id,
    })
  } catch (cause) {
    error.value = `无法读取实例信息：${messageOf(cause)}`
  } finally {
    loading.value = false
  }
}

async function loadUsage(): Promise<void> {
  if (usageLoading.value) return
  usageLoading.value = true
  notice.value = ''
  try {
    usage.value = await ctx.ipc.invoke<InstanceUsage>('mics.launch', 'instances/usage', {
      id: props.instance.id,
    })
  } catch (cause) {
    notice.value = `统计占用大小失败：${messageOf(cause)}`
  } finally {
    usageLoading.value = false
  }
}

function copyWithTextarea(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

async function copyPath(): Promise<void> {
  const value = detail.value?.dir
  if (!value) return
  notice.value = ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else if (!copyWithTextarea(value)) {
      throw new Error('当前环境不支持剪贴板')
    }
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch (cause) {
    // 权限受限时退回 textarea 方案，避免路径只能手抄
    if (copyWithTextarea(value)) {
      copied.value = true
      window.setTimeout(() => {
        copied.value = false
      }, 1500)
      return
    }
    notice.value = `复制路径失败：${messageOf(cause)}`
  }
}

async function reveal(area: InstanceArea): Promise<void> {
  notice.value = ''
  try {
    await ctx.ipc.invoke('mics.launch', 'instances/reveal', {
      id: props.instance.id,
      area,
    })
  } catch (cause) {
    notice.value = `打开文件夹失败：${messageOf(cause)}`
  }
}

async function loadLogs(preferred?: string): Promise<void> {
  logsLoading.value = true
  logsError.value = ''
  try {
    const files = await ctx.ipc.invoke<InstanceLogFile[]>('mics.launch', 'instances/logs', {
      id: props.instance.id,
    })
    logFiles.value = files
    logsLoaded = true

    const available = (name: string): boolean => files.some((file) => file.name === name)
    const next = preferred && available(preferred)
      ? preferred
      : logName.value && available(logName.value)
        ? logName.value
        : files[0]?.name

    if (next) {
      await openLog(next)
    } else {
      logSequence += 1
      logName.value = ''
      logContent.value = null
      logLoading.value = false
    }
  } catch (cause) {
    logsError.value = `读取日志列表失败：${messageOf(cause)}`
    logsLoaded = true
  } finally {
    logsLoading.value = false
  }
}

async function openLog(name: string): Promise<void> {
  if (!name) return
  const sequence = ++logSequence
  logName.value = name
  logLoading.value = true
  logsError.value = ''
  try {
    const content = await ctx.ipc.invoke<InstanceLogContent>('mics.launch', 'instances/log', {
      id: props.instance.id,
      name,
    })
    if (sequence !== logSequence) return
    logContent.value = content
    await nextTick()
    const view = logView.value
    if (view) view.scrollTop = view.scrollHeight
  } catch (cause) {
    if (sequence !== logSequence) return
    logContent.value = null
    logsError.value = `读取日志失败：${messageOf(cause)}`
  } finally {
    if (sequence === logSequence) logLoading.value = false
  }
}

async function identifyMods(entries: InstanceModEntry[]): Promise<void> {
  const sequence = ++identifySequence
  const files = entries
    .filter((entry) => entry.sha1 || entry.murmur2 !== undefined)
    .map((entry) => ({
      key: entry.fileName,
      ...(entry.sha1 ? { sha1: entry.sha1 } : {}),
      ...(entry.murmur2 !== undefined ? { murmur2: entry.murmur2 } : {}),
    }))
  if (files.length === 0) return

  try {
    const identities = await ctx.ipc.invoke<ModIdentity[]>(
      'mics.download.manager',
      'mods/identify',
      { files },
    )
    if (sequence !== identifySequence) return
    const currentEntries = mods.value?.entries
    if (!currentEntries) return
    const byFile = new Map(identities.map((identity) => [identity.key, identity]))
    for (const entry of currentEntries) {
      const identity = byFile.get(entry.fileName)
      if (!identity) continue
      entry.identity = identity
      // jar 没有图标时用项目的图标补上；仍没有则界面保留空位。
      if (!entry.icon && identity.project.icon) entry.icon = identity.project.icon
      if (!entry.modName && identity.project.name) entry.modName = identity.project.name
    }
  } catch {
    // 识别是增强信息，失败不影响本地列表与删除/启停
  }
}

async function loadMods(): Promise<void> {
  modsLoading.value = true
  modsError.value = ''
  try {
    const updated = await ctx.ipc.invoke<InstanceMods>('mics.launch', 'instances/mods', {
      id: props.instance.id,
    })
    mods.value = updated
    modsLoaded = true
    void identifyMods(updated.entries)
  } catch (cause) {
    modsError.value = `读取 Mod 失败：${messageOf(cause)}`
    modsLoaded = true
  } finally {
    modsLoading.value = false
  }
}

async function toggleMod(entry: InstanceModEntry, enabled = !entry.enabled): Promise<void> {
  if (modBusy.value === entry.fileName) return
  modBusy.value = entry.fileName
  modsError.value = ''
  try {
    const updated = await ctx.ipc.invoke<InstanceMods>('mics.launch', 'instances/mods/toggle', {
      id: props.instance.id,
      fileName: entry.fileName,
      enabled,
    })
    mods.value = updated
    emit('changed', updated.entries.filter((item) => item.enabled).length)
  } catch (cause) {
    modsError.value = `切换 Mod 状态失败：${messageOf(cause)}`
  } finally {
    modBusy.value = ''
  }
}

function markModIconFailed(fileName: string): void {
  brokenModIcons.value = { ...brokenModIcons.value, [fileName]: true }
}

/** 从文件名兜底推导搜索词：去掉加载器和版本尾巴 */
function modSearchQuery(entry: InstanceModEntry): string {
  if (entry.modId) return entry.modId
  if (entry.modName) return entry.modName
  const cleaned = entry.name
    .replace(/[-_+](fabric|forge|neoforge|quilt).*$/i, '')
    .replace(/[-_+]v?\d.*$/i, '')
    .trim()
  return cleaned || entry.name
}

function instanceLoaderKind(): ModLoader | 'all' {
  const label = props.instance.loader
  if (label === 'Fabric') return 'fabric'
  if (label === 'Forge') return 'forge'
  if (label === 'NeoForge') return 'neoforge'
  if (label === 'Quilt') return 'quilt'
  return 'all'
}

function openModDetail(entry: InstanceModEntry): void {
  const identity = entry.identity
  const intent: ModOpenIntent = identity
    ? {
        project: identity.project,
        query: identity.project.name,
        name: identity.project.name,
        fileName: entry.fileName,
        gameVersion: props.instance.minecraft,
        loader: instanceLoaderKind(),
        versionId: identity.versionId,
      }
    : {
        query: modSearchQuery(entry),
        ...(entry.modName ? { name: entry.modName } : {}),
        fileName: entry.fileName,
      }
  const globalStore = globalThis as typeof globalThis & Record<string, unknown>
  globalStore[MOD_OPEN_INTENT_KEY] = intent
  if (ctx.ui.navigate('download.mod')) return
  delete globalStore[MOD_OPEN_INTENT_KEY]
  notice.value = '无法打开 Mod 下载页，请确认下载插件已启用'
}

function requestDeleteMod(entry: InstanceModEntry): void {
  if (modBusy.value) return
  modDeleteTarget.value = entry
}

function closeDeleteMod(): void {
  if (modDeleting.value) return
  modDeleteTarget.value = null
}

async function confirmDeleteMod(): Promise<void> {
  const entry = modDeleteTarget.value
  if (!entry || modDeleting.value) return
  modDeleting.value = true
  modsError.value = ''
  try {
    const updated = await ctx.ipc.invoke<InstanceMods>('mics.launch', 'instances/mods/delete', {
      id: props.instance.id,
      fileName: entry.fileName,
    })
    mods.value = updated
    modDeleteTarget.value = null
    emit('changed', updated.entries.filter((item) => item.enabled).length)
  } catch (cause) {
    modsError.value = `删除 Mod 失败：${messageOf(cause)}`
    modDeleteTarget.value = null
  } finally {
    modDeleting.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  notice.value = ''
  try {
    await ctx.ipc.invoke('mics.launch', 'instances/delete', { id: props.instance.id })
    deleteOpen.value = false
    emit('deleted', props.instance.id)
  } catch (cause) {
    deleteOpen.value = false
    notice.value = `删除实例失败：${messageOf(cause)}`
  } finally {
    deleting.value = false
  }
}

watch(tab, (value) => {
  if (value === 'logs' && !logsLoaded) void loadLogs()
  if (value === 'mods' && !modsLoaded) void loadMods()
})

onMounted(() => {
  void loadDetail()
  void loadUsage()
})
</script>

<template>
  <div class="mics-page detail">
    <header class="mics-page__header detail__header">
      <div class="detail__identity">
        <button class="detail__back" type="button" aria-label="返回实例列表" @click="goBack">
          ←
        </button>
        <span class="mics-avatar" :class="avatarClass">{{ instance.name.slice(0, 1) }}</span>
        <div class="detail__titles">
          <h1 class="mics-page__title">{{ instance.name }}</h1>
          <div class="detail__badges">
            <span class="mics-badge">{{ instance.minecraft }}</span>
            <span class="mics-badge">{{ instance.loader }}</span>
            <span class="mics-badge" :class="{ 'mics-badge--accent': alive }">
              {{ statusLabel }}
            </span>
          </div>
        </div>
      </div>

      <div class="mics-page__actions">
        <button
          v-if="installPhase === 'incomplete'"
          class="mics-button mics-button--ghost mics-button--small"
          type="button"
          :disabled="repairing"
          @click="emit('repair')"
        >
          {{ repairing ? '补全中…' : '补全文件' }}
        </button>
        <button
          v-if="canLaunch"
          class="mics-button mics-button--primary mics-button--small"
          type="button"
          :disabled="starting || !accountReady"
          :title="accountReady ? '' : '先添加账户'"
          @click="requestPlay"
        >
          {{ starting ? '启动中…' : alive ? '再次启动' : '开始游戏' }}
        </button>
        <button
          v-if="alive"
          class="mics-button mics-button--danger mics-button--small"
          type="button"
          @click="requestTerminate"
        >
          终止进程
        </button>
        <button
          class="mics-button mics-button--danger mics-button--small"
          type="button"
          :disabled="deleting"
          @click="askDelete"
        >
          删除实例
        </button>
      </div>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div v-if="error" class="mics-empty mics-empty--error">
      {{ error }}
      <button class="mics-empty__action" type="button" @click="loadDetail">重试</button>
    </div>
    <div v-else-if="!detail" class="mics-empty">
      {{ loading ? '正在读取实例…' : '无法读取实例信息' }}
      <button v-if="!loading" class="mics-empty__action" type="button" @click="loadDetail">
        重试
      </button>
    </div>

    <template v-else>
      <div class="detail__tabs" role="tablist" aria-label="实例详情">
        <button
          v-for="item in TABS"
          :key="item.id"
          class="detail__tab"
          :class="{ 'is-active': tab === item.id }"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          @click="selectTab(item.id)"
        >
          {{ item.label }}
        </button>
      </div>

      <section v-if="tab === 'overview'" class="detail__grid">
        <div class="detail__card">
          <h2 class="mics-section__title">基本信息</h2>
          <dl class="detail__facts">
            <div>
              <dt>游戏版本</dt>
              <dd>{{ detail.minecraft }}</dd>
            </div>
            <div>
              <dt>加载器</dt>
              <dd>{{ detail.loader }}</dd>
            </div>
            <div>
              <dt>版本标识</dt>
              <dd class="detail__ellipsis" :title="detail.dir">{{ detail.versionId }}</dd>
            </div>
            <div>
              <dt>版本类型</dt>
              <dd>{{ detail.versionType ?? '未知' }}</dd>
            </div>
            <div>
              <dt>Java</dt>
              <dd>{{ detail.javaMajor ? `Java ${detail.javaMajor}` : '自动检测' }}</dd>
            </div>
            <div>
              <dt>已启用 Mod</dt>
              <dd>{{ detail.mods }} 个</dd>
            </div>
            <div>
              <dt>上次启动</dt>
              <dd>{{ formatDate(instance.lastPlayed) }}</dd>
            </div>
          </dl>
        </div>

        <div class="detail__card">
          <div class="detail__card-head">
            <h2 class="mics-section__title">占用空间</h2>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              type="button"
              :disabled="usageLoading"
              @click="loadUsage"
            >
              {{ usageLoading ? '统计中…' : '重新统计' }}
            </button>
          </div>

          <template v-if="usage">
            <div class="detail__size-total">
              {{ formatBytes(usage.total) }}
              <span class="mics-muted">{{ usage.files }} 个文件</span>
            </div>
            <div v-if="usageRows.length" class="detail__size-list">
              <div v-for="entry in usageRows" :key="entry.name" class="detail__size-row">
                <span class="detail__size-name" :title="entry.name">
                  {{ usageLabel(entry.name) }}
                </span>
                <span class="detail__size-bar">
                  <span :style="{ width: usagePercent(entry) + '%' }" />
                </span>
                <span class="detail__size-value">{{ formatBytes(entry.size) }}</span>
              </div>
              <span v-if="usageHiddenCount" class="detail__size-more">
                另有 {{ usageHiddenCount }} 项
              </span>
            </div>
          </template>
          <div v-else-if="usageLoading" class="mics-empty">正在统计实例占用…</div>
          <div v-else class="mics-empty">尚未统计</div>
        </div>

        <div class="detail__card detail__card--wide">
          <h2 class="mics-section__title">实例位置</h2>
          <div class="detail__path">
            <code class="detail__path-value" :title="detail.dir">{{ detail.dir }}</code>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              type="button"
              @click="copyPath"
            >
              {{ copied ? '已复制' : '复制路径' }}
            </button>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              type="button"
              @click="reveal('root')"
            >
              打开文件夹
            </button>
          </div>
        </div>
      </section>

      <section v-else-if="tab === 'logs'" class="detail__panel">
        <div class="mics-toolbar">
          <select
            v-model="logName"
            class="mics-select detail__log-select"
            :disabled="logsLoading || !logFiles.length"
            aria-label="选择日志文件"
            @change="openLog(logName)"
          >
            <option v-if="!logFiles.length" value="">没有日志文件</option>
            <option v-for="file in logFiles" :key="file.name" :value="file.name">
              {{ file.name }} · {{ formatBytes(file.size) }}
            </option>
          </select>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            :disabled="logsLoading"
            @click="loadLogs(logName)"
          >
            刷新
          </button>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            @click="reveal('logs')"
          >
            打开日志文件夹
          </button>
          <span v-if="logLoading" class="mics-muted">读取中…</span>
          <span v-else-if="logContent?.truncated" class="mics-muted">仅显示末尾内容</span>
        </div>

        <p v-if="logsError" class="mics-empty mics-empty--error">{{ logsError }}</p>
        <div v-else-if="logsLoading && !logFiles.length" class="mics-empty">正在读取日志列表…</div>
        <div v-else-if="!logFiles.length" class="mics-empty">
          还没有日志。启动一次游戏后，日志会出现在这里。
        </div>
        <pre v-else ref="logView" class="detail__log">{{ logContent?.content || (logLoading ? '正在读取日志…' : '日志为空') }}</pre>
      </section>

      <section v-else class="detail__panel">
        <div class="mics-toolbar">
          <input
            v-model="modQuery"
            class="mics-input mics-toolbar__grow"
            placeholder="搜索 Mod"
            spellcheck="false"
          />
          <span class="mics-muted">{{ enabledModCount }} / {{ modCount }} 已启用</span>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            :disabled="modsLoading || modBusy !== ''"
            @click="loadMods"
          >
            {{ modsLoading ? '读取中…' : '刷新' }}
          </button>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            type="button"
            @click="reveal('mods')"
          >
            打开 Mod 文件夹
          </button>
        </div>

        <p v-if="modsError" class="mics-empty mics-empty--error">{{ modsError }}</p>
        <div v-else-if="modsLoading && !mods" class="mics-empty">正在读取 Mod…</div>
        <div v-else-if="!modCount" class="mics-empty">Mod 文件夹为空。</div>
        <div v-else-if="!filteredMods.length" class="mics-empty">没有匹配的 Mod。</div>
        <div v-else class="mics-list">
          <div
            v-for="entry in filteredMods"
            :key="entry.fileName"
            class="mics-list__row detail__mod-row"
            role="button"
            tabindex="0"
            :aria-label="`查看 ${entry.name} 的详情`"
            @click="openModDetail(entry)"
            @keydown.enter="openModDetail(entry)"
          >
            <img
              v-if="entry.icon && !brokenModIcons[entry.fileName]"
              class="detail__mod-icon"
              :src="entry.icon"
              :alt="entry.name"
              @error="markModIconFailed(entry.fileName)"
            />
            <span v-else class="detail__mod-icon detail__mod-icon--empty" aria-hidden="true" />

            <div class="mics-list__main">
              <div class="mics-list__title">
                <span class="detail__mod-name" :title="entry.fileName">{{ entry.name }}</span>
              </div>
              <div class="mics-list__meta">
                {{ formatBytes(entry.size) }} · {{ formatDate(entry.modified) }}
              </div>
            </div>

            <button
              class="detail__mod-delete"
              type="button"
              title="删除 Mod"
              :aria-label="`删除 ${entry.name}`"
              :disabled="modBusy === entry.fileName"
              @click.stop="requestDeleteMod(entry)"
              @keydown.stop
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M19 6l-1 14H6L5 6" />
              </svg>
            </button>

            <ToggleSwitch
              :model-value="entry.enabled"
              :disabled="modBusy === entry.fileName"
              :label="`${entry.name}：${entry.enabled ? '已启用' : '已禁用'}`"
              :title="entry.enabled ? '点击禁用' : '点击启用'"
              @update:model-value="toggleMod(entry, $event)"
              @keydown.stop
            />
          </div>
        </div>
      </section>
    </template>

    <DeleteInstanceDialog
      :open="deleteOpen"
      :name="instance.name"
      :running="alive"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="closeDeleteDialog"
    />

    <DeleteModDialog
      :open="modDeleteTarget !== null"
      :name="modDeleteTarget?.fileName ?? ''"
      :busy="modDeleting"
      @confirm="confirmDeleteMod"
      @cancel="closeDeleteMod"
    />
  </div>
</template>

<style scoped>
.detail__header {
  align-items: center;
}

.detail__identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.detail__back {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  color: var(--mics-fg-muted);
  font-size: 14px;
  line-height: 1;
  transition: border-color 0.12s ease, color 0.12s ease;
}

.detail__back:hover {
  border-color: var(--mics-accent);
  color: var(--mics-fg);
}

.detail__titles {
  min-width: 0;
}

.detail__titles .mics-page__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}

.detail__tabs {
  align-self: flex-start;
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--mics-border);
  border-radius: 9px;
  background: var(--mics-bg-elevated);
}

.detail__tab {
  height: 28px;
  padding: 0 14px;
  border-radius: 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  transition: background 0.12s ease, color 0.12s ease;
}

.detail__tab:hover {
  color: var(--mics-fg);
}

.detail__tab.is-active {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.detail__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.detail__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--mics-border);
  border-radius: 10px;
  background: var(--mics-bg-elevated);
}

.detail__card--wide {
  grid-column: 1 / -1;
}

.detail__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.detail__facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
}

.detail__facts > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  font-size: 12px;
}

.detail__facts dt {
  flex: none;
  color: var(--mics-fg-muted);
}

.detail__facts dd {
  margin: 0;
  min-width: 0;
  text-align: right;
}

.detail__ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__path {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.detail__path-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 8px 10px;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  background: var(--mics-bg);
  color: var(--mics-fg-muted);
  font-family: "Cascadia Code", "Consolas", ui-monospace, monospace;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__size-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.detail__size-total .mics-muted {
  font-size: 11.5px;
  font-weight: 400;
}

.detail__size-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.detail__size-row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) 72px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.detail__size-name {
  overflow: hidden;
  color: var(--mics-fg-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__size-bar {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--mics-bg-hover);
}

.detail__size-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--mics-accent);
}

.detail__size-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.detail__size-more {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.detail__log-select {
  max-width: 360px;
}

.detail__log {
  margin: 0;
  min-height: 240px;
  max-height: calc(100vh - 330px);
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--mics-border);
  border-radius: 10px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg);
  font-family: "Cascadia Code", "Consolas", ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.detail__mod-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail__mod-row {
  gap: 10px;
  cursor: pointer;
}

.detail__mod-icon,
.detail__mod-icon--empty {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: cover;
}

.detail__mod-icon--empty {
  background: var(--mics-bg-hover);
}

.detail__mod-delete {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  background: transparent;
  color: var(--mics-fg-muted);
  transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.detail__mod-delete:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, transparent);
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.detail__mod-delete:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (max-width: 900px) {
  .detail__header {
    align-items: flex-start;
  }

  .detail__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .detail__card--wide {
    grid-column: auto;
  }

  .detail__path {
    flex-wrap: wrap;
  }

  .detail__path-value {
    flex-basis: 100%;
  }
}
</style>
