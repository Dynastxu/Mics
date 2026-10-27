<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { InstanceSummary } from '../shared'

const ctx = usePluginContext()
const instances = ref<InstanceSummary[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const selected = ref('')

const ACCENTS = ['', 'mics-avatar--amber', 'mics-avatar--teal', 'mics-avatar--rose']

function accent(index: number): string {
  return ACCENTS[index % ACCENTS.length] ?? ''
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

function play(instance: InstanceSummary): void {
  selected.value = instance.id
  notice.value = `已选择「${instance.name}」：启动流程尚未接入。`
}

onMounted(load)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">启动</h1>
      <div class="mics-page__actions">
        <button
          class="mics-button mics-button--ghost"
          @click="notice = '账户管理尚未接入。'"
        >
          <span class="launch__account-dot" />
          离线账户 · Steve
        </button>
        <button class="mics-button mics-button--ghost" @click="notice = '新建实例向导尚未接入。'">
          新建实例
        </button>
      </div>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <section class="mics-section">
      <h2 class="mics-section__title">实例 · {{ instances.length }}</h2>

      <div v-if="loading" class="mics-empty">正在读取实例…</div>
      <div v-else-if="error" class="mics-empty mics-empty--error">{{ error }}</div>
      <div v-else-if="!instances.length" class="mics-empty">还没有实例。</div>

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
            <div class="mics-list__meta">{{ instance.loader }} · {{ instance.mods }} 个 Mod</div>
          </div>
          <span class="launch__played">{{ instance.lastPlayed }}</span>
          <button
            class="mics-button mics-button--primary mics-button--small"
            @click="play(instance)"
          >
            开始游戏
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.launch__account-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
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
