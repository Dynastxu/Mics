<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { PluginInfo } from '@mics/sdk'

const ctx = usePluginContext()
const error = ref('')
const busy = ref<Record<string, boolean>>({})

const plugins = computed(() => ctx.plugins.list())
const activeCount = computed(
  () => plugins.value.filter((plugin) => plugin.state === 'active').length,
)

const STATE_LABEL: Record<string, string> = {
  discovered: '未激活',
  activating: '激活中',
  active: '已激活',
  failed: '失败',
  stopped: '已停止',
  disabled: '已禁用',
}

function label(plugin: PluginInfo): string {
  return STATE_LABEL[plugin.state] ?? plugin.state
}

function capability(plugin: PluginInfo): string {
  if (plugin.hasMain && plugin.hasRenderer) return '主进程 + 渲染'
  if (plugin.hasMain) return '主进程'
  if (plugin.hasRenderer) return '渲染'
  return '仅清单'
}

async function run(id: string, action: (id: string) => Promise<void>): Promise<void> {
  busy.value = { ...busy.value, [id]: true }
  error.value = ''
  try {
    await action(id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}

const activate = (id: string): Promise<void> => ctx.plugins.activate(id)
const disable = (id: string): Promise<void> => ctx.plugins.disable(id)
const enable = (id: string): Promise<void> => ctx.plugins.enable(id)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">插件管理</h1>
      <span class="mics-badge">{{ activeCount }} / {{ plugins.length }} 已激活</span>
    </header>

    <p v-if="error" class="inspector__error">{{ error }}</p>

    <div class="mics-list">
      <div v-for="plugin in plugins" :key="plugin.id" class="mics-list__row">
        <div class="mics-list__main">
          <div class="inspector__name">
            {{ plugin.name }}
            <span v-if="plugin.core" class="mics-badge mics-badge--accent">core</span>
          </div>
          <div class="mics-list__meta">
            {{ plugin.id }} · v{{ plugin.version }} · {{ capability(plugin) }}
          </div>
          <div v-if="plugin.error" class="inspector__plugin-error">{{ plugin.error }}</div>
        </div>

        <span class="mics-badge inspector__state" :data-state="plugin.state">
          {{ label(plugin) }}
        </span>

        <button
          v-if="plugin.state === 'disabled'"
          class="mics-button mics-button--primary mics-button--small"
          :disabled="busy[plugin.id]"
          @click="run(plugin.id, enable)"
        >
          {{ busy[plugin.id] ? '启用中…' : '启用' }}
        </button>
        <button
          v-else-if="plugin.state !== 'active'"
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="busy[plugin.id]"
          @click="run(plugin.id, activate)"
        >
          {{ busy[plugin.id] ? '激活中…' : '激活' }}
        </button>
        <button
          v-else
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="plugin.core || busy[plugin.id]"
          :title="plugin.core ? '内核插件不可禁用' : '禁用插件（持久化，不会自动重新启用）'"
          @click="run(plugin.id, disable)"
        >
          禁用
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inspector__error {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}

.inspector__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.inspector__state[data-state='active'] {
  color: var(--mics-accent);
}

.inspector__state[data-state='failed'] {
  color: var(--mics-danger);
}

.inspector__state[data-state='disabled'] {
  opacity: 0.65;
}

.inspector__plugin-error {
  margin-top: 4px;
  color: var(--mics-danger);
  font-size: 11.5px;
}
</style>
