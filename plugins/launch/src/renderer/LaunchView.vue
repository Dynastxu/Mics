<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type {
  InstanceSummary,
  LaunchProcessInfo,
  LaunchSettings,
  LaunchState,
  RepeatLaunchBehavior,
} from '../shared'
import { LAUNCH_STATE_TOPIC } from '../shared'
import InstanceDetailView from './InstanceDetailView.vue'
import RepeatLaunchDialog from './RepeatLaunchDialog.vue'

const ctx = usePluginContext()
const instances = ref<InstanceSummary[]>([])
const runtime = ref<LaunchState>({ instances: [] })
const settings = ref<LaunchSettings>({ repeatBehavior: 'prompt', maxMemory: 4096 })
const loading = ref(true)
const error = ref('')
const notice = ref('')
const selected = ref('')
const username = ref('Steve')
/** 正在执行启动 IPC（准备依赖、spawn 进程）的实例 */
const pending = ref<string[]>([])
const conflict = ref<InstanceSummary | null>(null)
/** 当前打开的实例详情；为空时展示实例列表 */
const detailId = ref('')

const detailInstance = computed(
  () => instances.value.find((instance) => instance.id === detailId.value) ?? null,
)

let offState: (() => void) | null = null

const ACCENTS = ['', 'mics-avatar--amber', 'mics-avatar--teal', 'mics-avatar--rose']

function accent(index: number): string {
  return ACCENTS[index % ACCENTS.length] ?? ''
}

function formatPlayed(timestamp: number | null): string {
  if (!timestamp) return '从未启动'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function processesOf(id: string): LaunchProcessInfo[] {
  return runtime.value.instances.find((entry) => entry.id === id)?.processes ?? []
}

function isStarting(instance: InstanceSummary): boolean {
  if (pending.value.includes(instance.id)) return true
  return processesOf(instance.id).some((process) => process.phase === 'starting')
}

function isAlive(id: string): boolean {
  return processesOf(id).length > 0
}

/** 「忽略」重复启动时，运行期间不再提供启动入口；进程结束后自动恢复 */
function isLaunchHidden(instance: InstanceSummary): boolean {
  return (
    settings.value.repeatBehavior === 'ignore' &&
    isAlive(instance.id) &&
    !isStarting(instance)
  )
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    instances.value = await ctx.ipc.invoke<InstanceSummary[]>('mics.launch', 'instances/list')
    if (detailId.value && !instances.value.some((instance) => instance.id === detailId.value)) {
      detailId.value = ''
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function openDetail(instance: InstanceSummary): void {
  selected.value = instance.id
  detailId.value = instance.id
}

function closeDetail(): void {
  detailId.value = ''
}

function handleDeleted(id: string): void {
  instances.value = instances.value.filter((instance) => instance.id !== id)
  if (selected.value === id) selected.value = ''
  if (detailId.value === id) detailId.value = ''
}

function handleModsChanged(mods: number): void {
  const instance = detailInstance.value
  if (instance) instance.mods = mods
}

function playDetail(): void {
  const instance = detailInstance.value
  if (instance) void play(instance)
}

function terminateDetail(): void {
  const instance = detailInstance.value
  if (instance) void terminate(instance)
}

async function refreshState(): Promise<void> {
  try {
    runtime.value = await ctx.ipc.invoke<LaunchState>('mics.launch', 'instances/state')
  } catch { /* 保留上一份状态 */ }
}

async function loadSettings(): Promise<void> {
  try {
    const value = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get')
    settings.value = value
  } catch { /* 使用默认的「提示」 */ }
}

async function loadAccount(): Promise<void> {
  try {
    const account = await ctx.ipc.invoke<{ username: string }>('mics.launch', 'account/get')
    username.value = account.username
  } catch { /* 使用默认离线名 */ }
}

async function saveUsername(): Promise<void> {
  try {
    const account = await ctx.ipc.invoke<{ username: string }>(
      'mics.launch',
      'account/set',
      { username: username.value },
    )
    username.value = account.username
  } catch (cause) {
    notice.value = `保存用户名失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function rememberBehavior(behavior: RepeatLaunchBehavior): Promise<void> {
  settings.value = { ...settings.value, repeatBehavior: behavior }
  try {
    const saved = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', {
      repeatBehavior: behavior,
    })
    settings.value = saved
  } catch { /* 保存失败时保留本次选择 */ }
}

async function startLaunch(instance: InstanceSummary): Promise<void> {
  if (isStarting(instance)) return
  selected.value = instance.id
  pending.value = [...pending.value, instance.id]
  notice.value = ''
  try {
    await saveUsername()
    await ctx.ipc.invoke('mics.launch', 'instances/launch', {
      id: instance.id,
      username: username.value,
    })
    instance.lastPlayed = Date.now()
    await refreshState()
  } catch (cause) {
    notice.value = `启动失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    pending.value = pending.value.filter((id) => id !== instance.id)
  }
}

async function play(instance: InstanceSummary): Promise<void> {
  if (isStarting(instance)) return

  if (isAlive(instance.id)) {
    const behavior = settings.value.repeatBehavior
    if (behavior === 'ignore') return
    if (behavior === 'prompt') {
      conflict.value = instance
      return
    }
  }

  await startLaunch(instance)
}

async function confirmConflict(dontAsk: boolean): Promise<void> {
  const instance = conflict.value
  conflict.value = null
  if (!instance) return
  if (dontAsk) await rememberBehavior('launch')
  await startLaunch(instance)
}

async function cancelConflict(dontAsk: boolean): Promise<void> {
  conflict.value = null
  if (dontAsk) await rememberBehavior('ignore')
}

async function terminate(instance: InstanceSummary): Promise<void> {
  try {
    await ctx.ipc.invoke('mics.launch', 'instances/terminate', { id: instance.id })
    await refreshState()
  } catch (cause) {
    notice.value = `终止失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

onMounted(() => {
  offState = ctx.ipc.on(LAUNCH_STATE_TOPIC, (payload) => {
    const state = payload as LaunchState | undefined
    if (state && Array.isArray(state.instances)) runtime.value = state
  })
  void load()
  void refreshState()
  void loadSettings()
  void loadAccount()
})

onUnmounted(() => {
  offState?.()
  offState = null
})
</script>

<template>
  <InstanceDetailView
    v-if="detailInstance"
    :instance="detailInstance"
    :processes="processesOf(detailInstance.id)"
    :starting="isStarting(detailInstance)"
    :can-launch="!isLaunchHidden(detailInstance)"
    @back="closeDetail"
    @play="playDetail"
    @terminate="terminateDetail"
    @deleted="handleDeleted"
    @changed="handleModsChanged"
  />

  <div v-else class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">启动</h1>
      <div class="mics-page__actions">
        <label class="launch__account" title="离线用户名">
          <span class="launch__account-dot" />
          <span class="launch__account-label">离线</span>
          <input
            v-model="username"
            class="mics-input launch__account-input"
            maxlength="16"
            aria-label="离线用户名"
            spellcheck="false"
            @change="saveUsername"
          />
        </label>
      </div>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <section class="mics-section">
      <h2 class="mics-section__title">实例 · {{ instances.length }}</h2>

      <div v-if="loading" class="mics-empty">正在读取实例…</div>
      <div v-else-if="error" class="mics-empty mics-empty--error">{{ error }}</div>
      <div v-else-if="!instances.length" class="mics-empty">还没有实例，请先在下载页安装一个版本。</div>

      <div v-else class="mics-list">
        <div
          v-for="(instance, index) in instances"
          :key="instance.id"
          class="mics-list__row launch__row"
          :class="{ 'is-selected': selected === instance.id }"
          @click="openDetail(instance)"
        >
          <span class="mics-avatar" :class="accent(index)">{{ instance.name.slice(0, 1) }}</span>
          <div class="mics-list__main">
            <div class="launch__name">
              {{ instance.name }}
              <span class="mics-badge">{{ instance.minecraft }}</span>
            </div>
            <div class="mics-list__meta">
              {{ instance.loader }} · {{ instance.mods }} 个 Mod
            </div>
          </div>
          <span class="launch__played">{{ formatPlayed(instance.lastPlayed) }}</span>
          <div class="launch__actions" @click.stop>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              @click="openDetail(instance)"
            >
              详情
            </button>
            <button
              v-if="!isLaunchHidden(instance)"
              class="mics-button mics-button--primary mics-button--small"
              :disabled="isStarting(instance)"
              @click="play(instance)"
            >
              {{ isStarting(instance) ? '启动中…' : '开始游戏' }}
            </button>
            <button
              v-if="isAlive(instance.id)"
              class="mics-button mics-button--danger mics-button--small"
              @click="terminate(instance)"
            >
              终止进程
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>

  <RepeatLaunchDialog
    :open="Boolean(conflict)"
    :instance-name="conflict?.name ?? ''"
    @confirm="confirmConflict"
    @cancel="cancelConflict"
  />
</template>

<style scoped>
.launch__account {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
}

.launch__account-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
}

.launch__account-label {
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.launch__account-input {
  width: 104px;
  height: 24px;
  padding: 0 6px;
  border-color: transparent;
  background: transparent;
}

.launch__account-input:hover {
  border-color: var(--mics-border);
}

.launch__account-input:focus {
  border-color: var(--mics-accent);
}

.launch__row {
  cursor: pointer;
}

.launch__row.is-selected {
  background: color-mix(in srgb, var(--mics-accent) 8%, transparent);
}

.launch__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.launch__played {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.launch__actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
</style>
