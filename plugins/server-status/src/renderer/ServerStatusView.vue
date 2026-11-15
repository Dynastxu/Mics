<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { ConfirmDialog } from '@mics/ui'
import type { ServerEdition, ServerEntry, ServerStatus, ServerStatusSettings } from '../shared'
import { DEFAULT_SETTINGS, MIN_REFRESH_SECONDS, PLUGIN_ID, VIEW_ID } from '../shared'
import AddServerDialog from './AddServerDialog.vue'
import ServerCard from './ServerCard.vue'

/**
 * 服务器状态页。
 *
 * 页面在页面栈里常驻，因此自动刷新只在**可见时**进行：切到别的页面后
 * `checkVisibility` 为 false，不再产生请求。列表、设置与查询结果都来自主进程，
 * 页面本身不缓存接口数据。
 */

const ctx = usePluginContext()

const root = ref<HTMLElement | null>(null)
const servers = ref<ServerEntry[]>([])
const statuses = ref<Record<string, ServerStatus>>({})
/** 正在查询的服务器 id；手动刷新与自动刷新共用 */
const refreshing = ref<string[]>([])
const loading = ref(true)
const error = ref('')
const settings = ref<ServerStatusSettings>({ ...DEFAULT_SETTINGS })

const addOpen = ref(false)
const addBusy = ref(false)
const addError = ref('')
const deleteTarget = ref<ServerEntry | null>(null)
const removing = ref(false)

const busy = computed(() => refreshing.value.length > 0)

let offViewActivated: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null
let lastRefreshAt = 0
let activated: Promise<void> | null = null

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function addressOf(server: ServerEntry): string {
  return `${server.host}:${server.port}`
}

/** 主进程半边默认不参与启动：第一次打开页面时才激活，并复用到之后的每次调用 */
function ensureMain(): Promise<void> {
  activated ??= ctx.plugins.activate(PLUGIN_ID).catch((cause) => {
    activated = null
    throw cause
  })
  return activated
}

async function invoke<T>(method: string, params?: unknown): Promise<T> {
  await ensureMain()
  return ctx.ipc.invoke<T>(PLUGIN_ID, method, params)
}

/** 列表变了之后丢掉已删除服务器的结果，避免卡片残留 */
function pruneStatuses(): void {
  const ids = new Set(servers.value.map((server) => server.id))
  const next: Record<string, ServerStatus> = {}
  for (const [id, status] of Object.entries(statuses.value)) {
    if (ids.has(id)) next[id] = status
  }
  statuses.value = next
}

async function refreshOne(id: string, force = true): Promise<void> {
  if (refreshing.value.includes(id)) return
  refreshing.value = [...refreshing.value, id]
  try {
    const [status] = await invoke<ServerStatus[]>('servers/status', { ids: [id], force })
    if (status) statuses.value = { ...statuses.value, [id]: status }
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    refreshing.value = refreshing.value.filter((entry) => entry !== id)
  }
}

async function refreshAll(force = true): Promise<void> {
  error.value = ''
  await Promise.allSettled(servers.value.map((server) => refreshOne(server.id, force)))
  pruneStatuses()
  lastRefreshAt = Date.now()
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const [list, current] = await Promise.all([
      invoke<ServerEntry[]>('servers/list'),
      invoke<ServerStatusSettings>('settings/read')
    ])
    servers.value = list
    settings.value = current
  } catch (cause) {
    error.value = messageOf(cause)
    return
  } finally {
    if (!silent) loading.value = false
  }
  await refreshAll(false)
}

/** 手动刷新：列表都还没读到时重读列表，否则强制重查所有服务器 */
async function manualRefresh(): Promise<void> {
  if (!servers.value.length) {
    await load(true)
    return
  }
  await refreshAll(true)
}

function openAdd(): void {
  addError.value = ''
  addOpen.value = true
}

function closeAdd(): void {
  if (addBusy.value) return
  addOpen.value = false
}

async function submitAdd(input: {
  address: string
  label: string
  edition: ServerEdition
}): Promise<void> {
  if (addBusy.value) return
  addBusy.value = true
  addError.value = ''
  try {
    servers.value = await invoke<ServerEntry[]>('servers/add', input)
    addOpen.value = false
    pruneStatuses()
    // 新服务器没有缓存，这次刷新只给它发请求，已有服务器命中缓存
    await refreshAll(false)
  } catch (cause) {
    addError.value = messageOf(cause)
  } finally {
    addBusy.value = false
  }
}

async function confirmRemove(): Promise<void> {
  const target = deleteTarget.value
  if (!target || removing.value) return
  removing.value = true
  error.value = ''
  try {
    servers.value = await invoke<ServerEntry[]>('servers/remove', { id: target.id })
    deleteTarget.value = null
    pruneStatuses()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    removing.value = false
  }
}

/**
 * 页面是否真的可见。
 *
 * 页面栈用 `visibility: hidden` 隐藏非当前页，而 `visibility` 是继承属性：
 * 读根元素的**计算后**样式即可判断，不依赖 `checkVisibility` 的选项名
 * （不同 Chromium 版本对 `visibilityProperty` / `checkVisibilityCSS` 支持不一）。
 */
function pageVisible(): boolean {
  const element = root.value
  if (!element) return false
  return getComputedStyle(element).visibility !== 'hidden'
}

function tick(): void {
  if (loading.value || !servers.value.length || !pageVisible()) return
  const interval = Math.max(MIN_REFRESH_SECONDS, settings.value.refreshSeconds) * 1000
  if (Date.now() - lastRefreshAt < interval) return
  void refreshAll(true)
}

onMounted(() => {
  // 页面常驻：每次重新激活时同步列表与设置（配置页改过刷新间隔也在这里生效）
  offViewActivated = ctx.on('ui/viewActivated', (viewId: string) => {
    if (viewId === VIEW_ID) void load(true)
  })
  ticker = setInterval(tick, 5000)
  void load()
})

onBeforeUnmount(() => {
  offViewActivated?.()
  offViewActivated = null
  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
})
</script>

<template>
  <div ref="root" class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">服务器状态</h1>
      <div class="mics-page__actions">
        <button
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="busy"
          @click="manualRefresh"
        >
          刷新
        </button>
        <button class="mics-button mics-button--primary mics-button--small" @click="openAdd">
          添加服务器
        </button>
      </div>
    </header>

    <p v-if="error" class="mics-notice server-status__error">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取服务器列表…</div>
    <div v-else-if="!servers.length" class="mics-empty">
      还没有服务器。
      <button class="mics-empty__action" @click="openAdd">添加服务器</button>
    </div>
    <div v-else class="mics-grid">
      <ServerCard
        v-for="server in servers"
        :key="server.id"
        :server="server"
        :status="statuses[server.id]"
        :refreshing="refreshing.includes(server.id)"
        @refresh="refreshOne(server.id)"
        @remove="deleteTarget = server"
      />
    </div>

    <AddServerDialog
      :open="addOpen"
      :busy="addBusy"
      :error="addError"
      @close="closeAdd"
      @submit="submitAdd"
    />

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="删除服务器"
      :message="deleteTarget ? `删除 ${deleteTarget.label}（${addressOf(deleteTarget)}）？` : ''"
      confirm-label="删除"
      confirm-variant="danger"
      default-focus="cancel"
      :busy="removing"
      busy-label="删除中…"
      width="420px"
      @confirm="confirmRemove"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<style scoped>
.server-status__error {
  margin: 0;
  border-color: color-mix(in srgb, var(--mics-danger) 45%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}
</style>
