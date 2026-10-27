<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { InstanceSummary, LaunchResult } from '../shared'

const ctx = usePluginContext()
const instances = ref<InstanceSummary[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const selected = ref('')
const username = ref('Steve')
const launching = ref('')

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

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    instances.value = await ctx.ipc.invoke<InstanceSummary[]>('mics.launch', 'instances/list')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
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

async function play(instance: InstanceSummary): Promise<void> {
  if (launching.value) return
  selected.value = instance.id
  launching.value = instance.id
  notice.value = ''
  try {
    await saveUsername()
    const result = await ctx.ipc.invoke<LaunchResult>('mics.launch', 'instances/launch', {
      id: instance.id,
      username: username.value,
    })
    notice.value = `已启动「${instance.name}」${result.pid ? `（PID ${result.pid}）` : ''}`
    await load()
  } catch (cause) {
    notice.value = `启动失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    launching.value = ''
  }
}

onMounted(() => {
  void load()
  void loadAccount()
})
</script>

<template>
  <div class="mics-page">
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
          <button
            class="mics-button mics-button--primary mics-button--small"
            :disabled="Boolean(launching)"
            @click="play(instance)"
          >
            {{ launching === instance.id ? '启动中…' : '开始游戏' }}
          </button>
        </div>
      </div>
    </section>
  </div>
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
</style>
