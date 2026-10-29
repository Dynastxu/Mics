<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { pluginIdOf } from '@mics/sdk'
import type {
  PluginId,
  PluginInfo,
  PluginInstallOutcome,
  PluginUninstallOutcome,
} from '@mics/sdk'
import { DataBrowser, ToggleSwitch } from '@mics/ui'
import type { FilterGroup, ListRow } from '@mics/ui'

const ctx = usePluginContext()
const selfId = pluginIdOf(ctx)
const installing = ref(false)
const error = ref('')
const busy = ref<Record<string, boolean>>({})
const failure = ref<Extract<PluginUninstallOutcome, { status: 'failed' }> | undefined>()

const plugins = computed(() => ctx.plugins.list())
const pluginMap = computed(() => new Map(plugins.value.map((plugin) => [plugin.id, plugin])))
const enabledCount = computed(
  () => plugins.value.filter((plugin) => plugin.status === 'enabled').length,
)

const FILTERS: FilterGroup[] = [
  {
    key: 'state',
    label: '状态',
    mode: 'multi',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: 'enabled', label: '已启用' },
      { value: 'disabled', label: '已禁用' },
      { value: 'failed', label: '失败' },
    ],
  },
]

const rows = computed<ListRow[]>(() =>
  plugins.value.map((plugin) => {
    const detail = [
      plugin.id,
      `v${plugin.version}`,
      capability(plugin),
      statusLabel(plugin),
      plugin.error ? `错误：${plugin.error}` : '',
    ].filter(Boolean)
    return {
      id: plugin.id,
      label: plugin.name,
      badges: [
        { label: plugin.source === 'builtin' ? '内置' : '第三方' },
        ...(plugin.core ? [{ label: 'core' }] : []),
        ...(plugin.essential ? [{ label: '必需' }] : []),
        ...(plugin.status === 'failed' ? [{ label: '失败', accent: true }] : []),
      ],
      meta: detail.join(' · '),
      keywords: [plugin.description ?? '', plugin.author ?? ''],
      tags: { state: plugin.status },
    }
  }),
)

function capability(plugin: PluginInfo): string {
  if (plugin.hasMain && plugin.hasRenderer) return '页面 + 后台'
  if (plugin.hasMain) return '仅后台'
  if (plugin.hasRenderer) return '仅页面'
  return '仅清单'
}

function statusLabel(plugin: PluginInfo): string {
  if (plugin.status === 'failed') return '失败'
  return plugin.status === 'disabled' ? '已禁用' : '已启用'
}

function pluginOf(id: string): PluginInfo | undefined {
  return pluginMap.value.get(id)
}

function isEnabled(id: string): boolean {
  return pluginOf(id)?.status !== 'disabled'
}

function busyOf(id: string): boolean {
  return Boolean(busy.value[id])
}

function switchTitle(id: string): string {
  const plugin = pluginOf(id)
  if (!plugin) return ''
  if (!plugin.canDisable) return plugin.core ? '内核插件不可禁用' : '必需插件不可禁用'
  return plugin.status === 'disabled' ? '启用插件' : '禁用插件'
}

async function invoke<T>(method: string, params?: unknown): Promise<T> {
  if (!selfId) throw new Error('[mics] 无法确定插件管理页的插件 id')
  return ctx.ipc.invoke<T>(selfId, method, params)
}

async function run(id: string, action: () => Promise<void>): Promise<void> {
  busy.value = { ...busy.value, [id]: true }
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = { ...busy.value, [id]: false }
  }
}

async function refresh(): Promise<void> {
  await ctx.plugins.refresh?.()
}

async function toggle(id: string, next: boolean): Promise<void> {
  const plugin = pluginOf(id)
  if (!plugin || !plugin.canDisable) return
  if (isEnabled(id) === next) return
  await run(id, async () => {
    if (next) await ctx.plugins.enable(id)
    else await ctx.plugins.disable(id)
  })
}

async function reload(id: string): Promise<void> {
  await run(id, async () => {
    await ctx.plugins.reload?.(id)
  })
}

async function install(): Promise<void> {
  installing.value = true
  error.value = ''
  failure.value = undefined
  try {
    const outcome = await invoke<PluginInstallOutcome>('plugin-manager/install')
    if (outcome.status === 'failed') error.value = outcome.message
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    installing.value = false
  }
}

/**
 * 卸载是「先卸页面，再让主进程删文件」：
 * 顺序反过来会让页面短暂指向一个已经不存在的目录。
 */
async function uninstall(id: PluginId, force = false): Promise<void> {
  await run(id, async () => {
    failure.value = undefined
    await ctx.plugins.unload?.(id)
    const outcome = await invoke<PluginUninstallOutcome>('plugin-manager/uninstall', { id, force })
    if (outcome.status === 'failed') {
      failure.value = outcome
    } else if (outcome.status === 'cancelled' && !force) {
      // 用户在确认框里点了取消：刚刚卸掉的页面要装回去
      await ctx.plugins.activate?.(id).catch(() => {})
    }
    await refresh()
  })
}
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">插件管理</h1>
      <div class="mics-page__actions">
        <span class="mics-badge">已启用 {{ enabledCount }} / {{ plugins.length }}</span>
        <button class="mics-button mics-button--primary" :disabled="installing" @click="install">
          {{ installing ? '安装中…' : '安装插件' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="inspector__error">{{ error }}</p>

    <div v-if="failure" class="inspector__error inspector__failure">
      <span>{{ failure.message }}</span>
      <span class="inspector__failure-actions">
        <button class="mics-button mics-button--ghost mics-button--small" @click="uninstall(failure.id)">
          重试
        </button>
        <button
          v-if="failure.retryable"
          class="mics-button mics-button--danger mics-button--small"
          @click="uninstall(failure.id, true)"
        >
          强制卸载
        </button>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          @click="failure = undefined"
        >
          忽略
        </button>
      </span>
    </div>

    <DataBrowser
      :items="rows"
      :groups="FILTERS"
      :mono="false"
      role="static"
      search-placeholder="搜索插件"
      empty-text="没有匹配的插件"
    >
      <template #actions="{ item }">
        <div class="inspector__actions">
          <ToggleSwitch
            :model-value="isEnabled(item.id)"
            :disabled="!pluginOf(item.id)?.canDisable || busyOf(item.id)"
            :label="`${item.label}：${isEnabled(item.id) ? '已启用' : '已禁用'}`"
            :title="switchTitle(item.id)"
            @update:model-value="toggle(item.id, $event)"
          />
          <button
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="busyOf(item.id) || !isEnabled(item.id)"
            title="重载插件"
            @click="reload(item.id)"
          >
            重载
          </button>
          <button
            v-if="pluginOf(item.id)?.uninstallable"
            class="mics-button mics-button--danger mics-button--small"
            :disabled="busyOf(item.id)"
            title="卸载插件"
            @click="uninstall(item.id)"
          >
            卸载
          </button>
        </div>
      </template>
    </DataBrowser>
  </div>
</template>

<style scoped>
.inspector__error {
  display: flex;
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
  line-height: 1.6;
}

.inspector__failure {
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.inspector__failure-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.inspector__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
