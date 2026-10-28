<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { PluginInfo } from '@mics/sdk'
import { DataBrowser, ToggleSwitch } from '@mics/ui'
import type { FilterGroup, ListRow } from '@mics/ui'

const ctx = usePluginContext()
const error = ref('')
const busy = ref<Record<string, boolean>>({})

const plugins = computed(() => ctx.plugins.list())
const pluginMap = computed(() => new Map(plugins.value.map((plugin) => [plugin.id, plugin])))
const enabledCount = computed(
  () => plugins.value.filter((plugin) => plugin.state !== 'disabled').length,
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
    ],
  },
]

const rows = computed<ListRow[]>(() =>
  plugins.value.map((plugin) => {
    const disabled = plugin.state === 'disabled'
    return {
      id: plugin.id,
      label: plugin.name,
      badges: [
        ...(plugin.core ? [{ label: 'core' }] : []),
        ...(plugin.essential ? [{ label: '必需' }] : []),
        ...(plugin.state === 'failed' ? [{ label: '失败' }] : []),
      ],
      meta: [plugin.id, `v${plugin.version}`, capability(plugin), plugin.error]
        .filter(Boolean)
        .join(' · '),
      keywords: [plugin.description ?? '', disabled ? '禁用' : '启用'],
      tags: { state: disabled ? 'disabled' : 'enabled' },
    }
  }),
)

function capability(plugin: PluginInfo): string {
  if (plugin.hasMain && plugin.hasRenderer) return '主进程 + 渲染'
  if (plugin.hasMain) return '主进程'
  if (plugin.hasRenderer) return '渲染'
  return '仅清单'
}

function pluginOf(id: string): PluginInfo | undefined {
  return pluginMap.value.get(id)
}

function isEnabled(id: string): boolean {
  return pluginOf(id)?.state !== 'disabled'
}

function isLocked(id: string): boolean {
  const plugin = pluginOf(id)
  return !plugin || plugin.core || plugin.essential
}

function busyOf(id: string): boolean {
  return Boolean(busy.value[id])
}

function switchTitle(id: string): string {
  const plugin = pluginOf(id)
  if (!plugin) return ''
  if (plugin.essential) return '插件管理自身不可禁用'
  if (plugin.core) return '内核插件不可禁用'
  return plugin.state === 'disabled' ? '启用插件' : '禁用插件'
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

const enable = (id: string): Promise<void> => ctx.plugins.enable(id)
const disable = (id: string): Promise<void> => ctx.plugins.disable(id)

async function toggle(id: string, next: boolean): Promise<void> {
  const plugin = pluginOf(id)
  if (!plugin || plugin.core || plugin.essential) return
  if ((plugin.state !== 'disabled') === next) return
  await run(id, next ? enable : disable)
}
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">插件管理</h1>
      <span class="mics-badge">已启用 {{ enabledCount }} / {{ plugins.length }}</span>
    </header>

    <p v-if="error" class="inspector__error">{{ error }}</p>

    <DataBrowser
      :items="rows"
      :groups="FILTERS"
      :mono="false"
      role="static"
      search-placeholder="搜索插件"
      empty-text="没有匹配的插件"
    >
      <template #actions="{ item }">
        <ToggleSwitch
          :model-value="isEnabled(item.id)"
          :disabled="isLocked(item.id) || busyOf(item.id)"
          :label="`${item.label}：${isEnabled(item.id) ? '已启用' : '已禁用'}`"
          :title="switchTitle(item.id)"
          @update:model-value="toggle(item.id, $event)"
        />
      </template>
    </DataBrowser>
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
</style>
