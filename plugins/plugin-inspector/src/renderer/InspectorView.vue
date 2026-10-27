<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { PluginInfo } from '@mics/sdk'

const ctx = usePluginContext()
const error = ref('')
const busy = ref<Record<string, boolean>>({})

const plugins = computed(() => ctx.plugins.list())

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

async function activate(id: string): Promise<void> {
  busy.value = { ...busy.value, [id]: true }
  error.value = ''
  try {
    await ctx.plugins.activate(id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}

async function disable(id: string): Promise<void> {
  busy.value = { ...busy.value, [id]: true }
  error.value = ''
  try {
    await ctx.plugins.disable(id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}

async function enable(id: string): Promise<void> {
  busy.value = { ...busy.value, [id]: true }
  error.value = ''
  try {
    await ctx.plugins.enable(id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}
</script>

<template>
  <div class="inspector">
    <header class="inspector__header">
      <div>
        <h2>插件</h2>
        <p>清单来自 plugin.json，代码在首次使用时才加载。</p>
      </div>
      <span class="inspector__badge">
        {{ plugins.filter((plugin) => plugin.state === 'active').length }} / {{ plugins.length }} 已激活
      </span>
    </header>

    <p v-if="error" class="inspector__error">{{ error }}</p>

    <table class="inspector__table">
      <thead>
        <tr>
          <th>插件</th>
          <th>版本</th>
          <th>能力</th>
          <th>状态</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="plugin in plugins" :key="plugin.id">
          <td>
            <div class="inspector__name">
              {{ plugin.name }}
              <span v-if="plugin.core" class="inspector__tag">core</span>
            </div>
            <div class="inspector__id">{{ plugin.id }}</div>
            <div v-if="plugin.error" class="inspector__plugin-error">{{ plugin.error }}</div>
          </td>
          <td class="inspector__muted">{{ plugin.version }}</td>
          <td class="inspector__muted">
            <span v-if="plugin.hasMain">主进程 </span>
            <span v-if="plugin.hasRenderer">渲染 </span>
            <span v-if="!plugin.hasMain && !plugin.hasRenderer">—</span>
          </td>
          <td>
            <span class="inspector__state" :data-state="plugin.state">{{ label(plugin) }}</span>
          </td>
          <td class="inspector__actions">
            <button
              v-if="plugin.state === 'disabled'"
              class="inspector__button"
              :disabled="busy[plugin.id]"
              @click="enable(plugin.id)"
            >
              {{ busy[plugin.id] ? '启用中…' : '启用' }}
            </button>
            <button
              v-else-if="plugin.state !== 'active'"
              class="inspector__button"
              :disabled="busy[plugin.id]"
              @click="activate(plugin.id)"
            >
              {{ busy[plugin.id] ? '激活中…' : '激活' }}
            </button>
            <button
              v-else
              class="inspector__button inspector__button--ghost"
              :disabled="plugin.core || busy[plugin.id]"
              :title="plugin.core ? '内核插件不可禁用' : '禁用插件（持久化，不会自动重新启用）'"
              @click="disable(plugin.id)"
            >
              禁用
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.inspector {
  max-width: 880px;
}

.inspector__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.inspector__header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.inspector__header p {
  margin: 0;
  color: var(--mics-fg-muted);
}

.inspector__badge {
  padding: 4px 10px;
  border: 1px solid var(--mics-border);
  border-radius: 999px;
  color: var(--mics-fg-muted);
  font-size: 11px;
  white-space: nowrap;
}

.inspector__error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}

.inspector__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.inspector__table th {
  padding: 8px 10px;
  border-bottom: 1px solid var(--mics-border);
  color: var(--mics-fg-muted);
  font-weight: 600;
  text-align: left;
}

.inspector__table td {
  padding: 10px;
  border-bottom: 1px solid var(--mics-border);
  vertical-align: top;
}

.inspector__name {
  color: var(--mics-fg);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.inspector__tag {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--mics-bg-hover);
  color: var(--mics-accent);
  font-size: 10px;
  font-weight: 500;
}

.inspector__id {
  margin-top: 2px;
  color: var(--mics-fg-muted);
  font-size: 11px;
}

.inspector__plugin-error {
  margin-top: 4px;
  color: var(--mics-danger);
  font-size: 11px;
}

.inspector__muted {
  color: var(--mics-fg-muted);
  white-space: nowrap;
}

.inspector__state {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 11px;
  white-space: nowrap;
}

.inspector__state[data-state='active'] {
  color: var(--mics-accent);
}

.inspector__state[data-state='failed'] {
  color: var(--mics-danger);
}

.inspector__state[data-state='disabled'] {
  color: var(--mics-fg-muted);
  opacity: 0.7;
}

.inspector__actions {
  text-align: right;
  white-space: nowrap;
}

.inspector__button {
  padding: 5px 12px;
  border-radius: 6px;
  background: var(--mics-accent);
  color: var(--mics-accent-fg);
  font-size: 12px;
}

.inspector__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.inspector__button--ghost {
  background: transparent;
  border: 1px solid var(--mics-border);
  color: var(--mics-fg);
}
</style>
