<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { pluginIdOf } from '@mics/sdk'
import type {
  PluginConfigurationInfo,
  PluginContributionRef,
  PluginDependencyDetail,
  PluginDependencyRef,
  PluginFailureStage,
  PluginGraphNode,
  PluginGraphReport,
  PluginId,
  PluginInfo,
  PluginInstallOutcome,
  PluginProvideRef,
  PluginStatus,
  PluginUninstallOutcome,
} from '@mics/sdk'
import { DataBrowser, ToggleSwitch } from '@mics/ui'
import type { FilterGroup, ListRow } from '@mics/ui'
import PluginSettingsPanel from './PluginSettingsPanel.vue'

const ctx = usePluginContext()
const selfId = pluginIdOf(ctx)
const root = ref<HTMLElement>()
const installing = ref(false)
const error = ref('')
const busy = ref<Record<string, boolean>>({})
const failure = ref<Extract<PluginUninstallOutcome, { status: 'failed' }> | undefined>()
const graph = ref<PluginGraphReport>()
const graphError = ref('')
const selectedId = ref<PluginId>('')
/** 各插件声明了 schema 的配置项；插件详情里直接编辑 */
const configs = ref<PluginConfigurationInfo[]>([])
/** 防止快速的状态变化让旧诊断响应覆盖新响应 */
let graphSeq = 0

const plugins = computed(() => ctx.plugins.list())
const pluginMap = computed(() => new Map(plugins.value.map((plugin) => [plugin.id, plugin])))
const enabledCount = computed(
  () =>
    plugins.value.filter((plugin) => plugin.status === 'enabled' || plugin.status === 'waiting')
      .length,
)

const nodeMap = computed<Map<PluginId, PluginGraphNode>>(
  () => new Map((graph.value?.nodes ?? []).map((node) => [node.id, node] as const)),
)
const selectedNode = computed(() => nodeMap.value.get(selectedId.value))
const selectedInfo = computed(() => pluginOf(selectedId.value))
const selectedConfig = computed(() =>
  configs.value.find((config) => config.pluginId === selectedId.value),
)
const scanIssues = computed(() => graph.value?.scanIssues ?? [])
const unmetOfSelected = computed(() =>
  (graph.value?.unmet ?? []).filter((item) => item.neededBy.includes(selectedId.value)),
)

const FILTERS: FilterGroup[] = [
  {
    key: 'state',
    label: '状态',
    mode: 'single',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: 'enabled', label: '已启用' },
      { value: 'waiting', label: '等待依赖' },
      { value: 'disabled', label: '已禁用' },
      { value: 'failed', label: '失败' },
    ],
  },
  {
    key: 'form',
    label: '形态',
    mode: 'multi',
    exclusive: 'all',
    options: [
      { value: 'all', label: '全部' },
      { value: 'page', label: '页面' },
      { value: 'main', label: '后台' },
      { value: 'manifest', label: '清单' },
    ],
  },
]

const STAGE_LABELS: Record<PluginFailureStage, string> = {
  manifest: '清单',
  import: '导入',
  apply: '启动',
  dependency: '依赖',
  timeout: '停止超时',
  renderer: '页面',
  policy: '策略',
}

const CONTRIBUTION_LABELS: Record<PluginContributionRef['kind'], string> = {
  rpc: 'RPC',
  command: '命令',
  view: '页面',
  navGroup: '导航分组',
  statusBar: '状态栏',
  theme: '主题',
  layout: '布局',
  configuration: '配置',
}

const rows = computed<ListRow[]>(() =>
  plugins.value.map((plugin) => {
    const detail = [
      plugin.id,
      `v${plugin.version}`,
      plugin.waitingFor?.length ? `等待：${plugin.waitingFor.join('、')}` : '',
      plugin.dependencyIssues?.length ? `依赖：${plugin.dependencyIssues.join('；')}` : '',
      plugin.failure ? failureText(plugin) : '',
    ].filter(Boolean)
    return {
      id: plugin.id,
      label: plugin.name,
      badges: [
        { label: plugin.source === 'builtin' ? '内置' : '第三方' },
        ...formBadges(plugin),
        ...(plugin.core ? [{ label: 'core' }] : []),
        ...(plugin.essential ? [{ label: '必需' }] : []),
        ...(plugin.profileLocked
          ? [{ label: plugin.profileLocked === 'enabled' ? 'profile 启用' : 'profile 禁用' }]
          : []),
        ...(plugin.status === 'waiting' ? [{ label: '等待依赖' }] : []),
        ...(plugin.restartRequired && !plugin.failure ? [{ label: '需重启' }] : []),
        ...(plugin.failure
          ? [{ label: `失败·${STAGE_LABELS[plugin.failure.stage]}`, accent: true }]
          : []),
      ],
      meta: detail.join(' · '),
      keywords: [plugin.description ?? '', plugin.author ?? ''],
      tags: { state: plugin.status, form: formTags(plugin) },
    }
  }),
)

/** 徽章：页面 / 后台 各自独立，既没有入口也没有主进程时只标「清单」 */
function formBadges(plugin: PluginInfo): NonNullable<ListRow['badges']> {
  const badges: NonNullable<ListRow['badges']> = []
  if (plugin.hasRenderer) badges.push({ label: '页面' })
  if (plugin.hasMain) badges.push({ label: '后台' })
  if (!badges.length) badges.push({ label: '清单' })
  return badges
}

/** 带形态的插件一行可以有多个标签（页面 + 后台），筛选按「同时满足」合并 */
function formTags(plugin: PluginInfo): string[] {
  const tags = [plugin.hasRenderer ? 'page' : '', plugin.hasMain ? 'main' : ''].filter(Boolean)
  return tags.length ? tags : ['manifest']
}

function statusLabelOf(status?: PluginStatus): string {
  if (status === 'failed') return '失败'
  if (status === 'waiting') return '等待依赖'
  if (status === 'disabled') return '已禁用'
  return status === 'enabled' ? '已启用' : '未安装'
}

function failureText(plugin: PluginInfo): string {
  if (!plugin.failure) return ''
  return `失败（${STAGE_LABELS[plugin.failure.stage]}）：${plugin.failure.message}`
}

function failureHint(stage: PluginFailureStage): string {
  switch (stage) {
    case 'manifest':
      return '清单无效。修正 plugin.json，或重新安装这个插件。'
    case 'import':
      return '入口产物导入失败。确认已构建（pnpm build:plugins）后重载。'
    case 'apply':
      return '插件启动时抛错。修好代码后重载即可。'
    case 'renderer':
      return '页面产物加载失败。修好渲染端代码后重载。'
    case 'dependency':
      return '依赖没有满足。先启用或安装依赖插件，再重载。'
    case 'timeout':
      return '旧代码没有在时限内停止，可能仍在后台运行。需要重启应用；重启前不要再重载。'
    case 'policy':
      return '被策略插件拒绝激活。查看日志或调整策略配置。'
  }
}

function canReload(stage?: PluginFailureStage): boolean {
  return stage === 'import' || stage === 'apply' || stage === 'renderer'
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
  if (plugin.profileLocked === 'enabled') return 'profile 强制启用'
  if (plugin.profileLocked === 'disabled') return 'profile 强制禁用'
  if (!plugin.canDisable) return plugin.core ? '内核插件不可禁用' : '必需插件不可禁用'
  return plugin.status === 'disabled' ? '启用插件' : '禁用插件'
}

function dependencyLabel(detail: PluginDependencyDetail): string {
  if (detail.kind === 'manifest') return '清单依赖'
  if (detail.kind === 'service') return `服务 ${detail.via}`
  return `能力 ${detail.via}`
}

function dependencyText(dependency: PluginDependencyRef): string {
  return dependency.details
    .map((detail) => `${dependencyLabel(detail)}${detail.satisfied ? '' : '（未满足）'}`)
    .join(' · ')
}

function provideText(item: PluginProvideRef): string {
  const label = item.kind === 'service' ? '服务' : '能力'
  return item.label ? `${label} ${item.name} · ${item.label}` : `${label} ${item.name}`
}

function contributionText(item: PluginContributionRef): string {
  const title = item.title && item.title !== item.id ? ` · ${item.title}` : ''
  return `${CONTRIBUTION_LABELS[item.kind]} ${item.id}${title}`
}

function selectPlugin(id: string): void {
  if (!pluginOf(id)) return
  selectedId.value = id
  scrollToTop()
}

/** 切换列表与详情后回到页面顶部，否则点开时看到的是半截详情 */
function scrollToTop(): void {
  void nextTick(() => root.value?.scrollIntoView({ block: 'start' }))
}

function clearSelection(): void {
  selectedId.value = ''
  scrollToTop()
}

/** 依赖失败时把用户送到第一个未满足的依赖上 */
function focusDependency(): void {
  const dependency = selectedNode.value?.dependsOn.find((item) => !item.satisfied)
  if (dependency && pluginOf(dependency.id)) selectedId.value = dependency.id
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

async function loadGraph(): Promise<void> {
  const seq = ++graphSeq
  graphError.value = ''
  try {
    const next = await ctx.plugins.diagnostics?.()
    if (seq === graphSeq) graph.value = next
  } catch (cause) {
    if (seq === graphSeq) graphError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function loadConfigs(): Promise<void> {
  try {
    configs.value = await ctx.ipc.invoke<PluginConfigurationInfo[]>('mics.kernel', 'configuration/list')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function replaceConfig(next: PluginConfigurationInfo): void {
  const index = configs.value.findIndex((config) => config.pluginId === next.pluginId)
  if (index >= 0) configs.value[index] = next
  else configs.value.push(next)
}

/** 插件自带设置页时，详情里只给入口，不在本地重复渲染同一批设置 */
function openSettings(view: string): void {
  if (!ctx.ui.navigate(view)) error.value = `设置页 ${view} 当前不可用`
}

async function refresh(): Promise<void> {
  await ctx.plugins.refresh?.()
  await loadGraph()
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

let stopGraphWatch: (() => void) | undefined

onMounted(() => {
  void loadGraph()
  void loadConfigs()
  // 内核状态变化时重取诊断与配置；页面不自己推断依赖关系
  stopGraphWatch = ctx.plugins.onDidChange(() => {
    // 当前详情所属插件被卸载/移除后回到列表，避免停在一个空详情页
    if (selectedId.value && !pluginOf(selectedId.value)) selectedId.value = ''
    void loadGraph()
    void loadConfigs()
  })
})

onBeforeUnmount(() => {
  stopGraphWatch?.()
})
</script>

<template>
  <div ref="root" class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">插件管理</h1>
      <div class="mics-page__actions">
        <button
          v-if="selectedId"
          class="mics-button mics-button--ghost mics-button--small"
          @click="clearSelection"
        >
          返回列表
        </button>
        <template v-else>
          <span class="mics-badge">已启用 {{ enabledCount }} / {{ plugins.length }}</span>
          <button class="mics-button mics-button--primary" :disabled="installing" @click="install">
            {{ installing ? '安装中…' : '安装插件' }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="error" class="inspector__error">{{ error }}</p>
    <p v-if="graphError" class="inspector__error">诊断读取失败：{{ graphError }}</p>

    <div v-if="!selectedId && scanIssues.length" class="inspector__issue">
      <strong>{{ scanIssues.length }} 个插件目录无法加载</strong>
      <ul>
        <li v-for="issue in scanIssues" :key="issue.dir">
          <span class="mics-mono">{{ issue.dir }}</span>
          <span>{{ issue.errors.join('；') }}</span>
        </li>
      </ul>
    </div>

    <div v-if="!selectedId && failure" class="inspector__error inspector__failure">
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
      v-if="!selectedId"
      :items="rows"
      :groups="FILTERS"
      :mono="false"
      role="radio"
      :selected-id="selectedId"
      search-placeholder="搜索插件"
      empty-text="没有匹配的插件"
      @select="selectPlugin"
    >
      <template #actions="{ item }">
        <div class="inspector__actions" @click.stop>
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
          <ToggleSwitch
            :model-value="isEnabled(item.id)"
            :disabled="!pluginOf(item.id)?.canDisable || busyOf(item.id)"
            :label="`${item.label}：${isEnabled(item.id) ? '已启用' : '已禁用'}`"
            :title="switchTitle(item.id)"
            @update:model-value="toggle(item.id, $event)"
          />
        </div>
      </template>
    </DataBrowser>

    <section v-else class="inspector__detail">
      <header class="inspector__detail-head">
        <div>
          <h2 class="inspector__detail-title">{{ selectedInfo?.name }}</h2>
          <p class="inspector__detail-meta mics-mono">
            {{ selectedInfo?.id }} · v{{ selectedInfo?.version }}
          </p>
          <p v-if="selectedInfo?.description" class="inspector__detail-desc">
            {{ selectedInfo.description }}
          </p>
        </div>
        <div class="inspector__actions">
          <button
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="busyOf(selectedId) || !isEnabled(selectedId)"
            title="重载插件"
            @click="reload(selectedId)"
          >
            重载
          </button>
          <button
            v-if="selectedInfo?.uninstallable"
            class="mics-button mics-button--danger mics-button--small"
            :disabled="busyOf(selectedId)"
            title="卸载插件"
            @click="uninstall(selectedId)"
          >
            卸载
          </button>
          <ToggleSwitch
            :model-value="isEnabled(selectedId)"
            :disabled="!selectedInfo?.canDisable || busyOf(selectedId)"
            :label="`${selectedInfo?.name ?? selectedId}：${isEnabled(selectedId) ? '已启用' : '已禁用'}`"
            :title="switchTitle(selectedId)"
            @update:model-value="toggle(selectedId, $event)"
          />
        </div>
      </header>

      <div v-if="selectedInfo?.failure" class="inspector__failure-detail">
        <span class="mics-badge mics-badge--accent">
          {{ STAGE_LABELS[selectedInfo.failure.stage] }}
        </span>
        <span>{{ selectedInfo.failure.message }}</span>
        <span class="inspector__failure-actions">
          <button
            v-if="canReload(selectedInfo.failure.stage)"
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="busyOf(selectedId)"
            @click="reload(selectedId)"
          >
            重载
          </button>
          <button
            v-if="selectedInfo.failure.stage === 'dependency'"
            class="mics-button mics-button--ghost mics-button--small"
            @click="focusDependency"
          >
            查看依赖
          </button>
          <button
            v-if="selectedInfo.failure.stage === 'dependency'"
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="busyOf(selectedId)"
            @click="reload(selectedId)"
          >
            重载
          </button>
          <button
            v-if="selectedInfo.failure.stage === 'manifest'"
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="installing"
            @click="install"
          >
            重新安装
          </button>
        </span>
        <p class="inspector__muted">{{ failureHint(selectedInfo.failure.stage) }}</p>
      </div>

      <div v-else-if="selectedInfo?.waitingFor?.length" class="inspector__notice">
        等待服务：{{ selectedInfo.waitingFor.join('、') }}
      </div>

      <div v-if="selectedInfo?.restartRequired && !selectedInfo.failure" class="inspector__notice">
        上次停止超时，旧代码可能仍在运行；需要重启应用后才能继续操作。
      </div>

      <div v-if="selectedNode?.warnings.length" class="inspector__notice">
        {{ selectedNode?.warnings.join('；') }}
      </div>

      <section v-if="selectedConfig" class="inspector__settings">
        <h3>设置</h3>
        <p v-if="selectedConfig.description" class="inspector__muted">
          {{ selectedConfig.description }}
        </p>
        <div v-if="selectedConfig.settingsView" class="inspector__settings-entry">
          <button
            class="mics-button mics-button--ghost mics-button--small"
            @click="openSettings(selectedConfig.settingsView)"
          >
            打开设置页
          </button>
        </div>
        <PluginSettingsPanel
          v-else
          :config="selectedConfig"
          @updated="replaceConfig"
        />
      </section>

      <div v-if="selectedNode" class="inspector__columns">
        <section class="inspector__column">
          <h3>依赖</h3>
          <ul v-if="selectedNode.dependsOn.length">
            <li v-for="dependency in selectedNode.dependsOn" :key="dependency.id">
              <button
                class="inspector__link"
                :disabled="!pluginOf(dependency.id)"
                @click="selectPlugin(dependency.id)"
              >
                {{ dependency.name }}
              </button>
              <span class="inspector__muted"> · {{ statusLabelOf(dependency.status) }}</span>
              <div class="inspector__muted">{{ dependencyText(dependency) }}</div>
            </li>
          </ul>
          <p v-else class="inspector__muted">无</p>
        </section>

        <section class="inspector__column">
          <h3>被依赖</h3>
          <ul v-if="selectedNode.dependents.length">
            <li v-for="dependent in selectedNode.dependents" :key="dependent.id">
              <button
                class="inspector__link"
                :disabled="!pluginOf(dependent.id)"
                @click="selectPlugin(dependent.id)"
              >
                {{ dependent.name }}
              </button>
              <span class="inspector__muted"> · {{ statusLabelOf(dependent.status) }}</span>
              <div class="inspector__muted">{{ dependencyText(dependent) }}</div>
            </li>
          </ul>
          <p v-else class="inspector__muted">无</p>
        </section>

        <section class="inspector__column">
          <h3>提供</h3>
          <ul v-if="selectedNode.provides.length">
            <li
              v-for="item in selectedNode.provides"
              :key="`${item.kind}:${item.name}:${item.label ?? ''}`"
            >
              {{ provideText(item) }}
            </li>
          </ul>
          <p v-else class="inspector__muted">无</p>
        </section>

        <section class="inspector__column">
          <h3>贡献</h3>
          <ul v-if="selectedNode.contributes.length">
            <li v-for="item in selectedNode.contributes" :key="`${item.kind}:${item.id}`">
              {{ contributionText(item) }}
            </li>
          </ul>
          <p v-else class="inspector__muted">无</p>
        </section>
      </div>

      <div v-if="selectedNode && unmetOfSelected.length" class="inspector__unmet">
        <h3>未满足</h3>
        <ul>
          <li v-for="item in unmetOfSelected" :key="`${item.kind}:${item.name}`">
            {{ item.kind === 'service' ? '服务' : item.kind === 'capability' ? '能力' : '插件' }}
            {{ item.name }}
          </li>
        </ul>
      </div>
    </section>
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
  flex: none;
  align-items: center;
  gap: 8px;
}

.inspector__issue {
  padding: 10px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  background: var(--mics-bg-elevated);
  font-size: 12px;
  line-height: 1.6;
}

.inspector__issue ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.inspector__issue li {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.inspector__detail {
  padding: 14px 16px;
  border: 1px solid var(--mics-border);
  border-radius: 10px;
  background: var(--mics-bg-elevated);
}

.inspector__detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.inspector__detail-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.inspector__detail-meta {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.inspector__detail-desc {
  margin: 6px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.6;
}

.inspector__failure-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}

.inspector__failure-detail .inspector__muted {
  flex-basis: 100%;
  margin: 0;
}

.inspector__notice {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.inspector__columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
  margin-top: 14px;
}

.inspector__column h3,
.inspector__settings h3,
.inspector__unmet h3 {
  margin: 0 0 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  font-weight: 600;
}

.inspector__settings {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--mics-border);
}

.inspector__settings .inspector__muted {
  margin: 0 0 8px;
  font-size: 12px;
}

.inspector__settings-entry {
  display: flex;
  gap: 8px;
}

.inspector__column ul,
.inspector__unmet ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.inspector__column li,
.inspector__unmet li {
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.inspector__link {
  padding: 0;
  color: var(--mics-accent);
  text-align: left;
}

.inspector__link:hover:not(:disabled) {
  text-decoration: underline;
}

.inspector__link:disabled {
  color: inherit;
  cursor: default;
}

.inspector__muted {
  color: var(--mics-fg-muted);
}

.inspector__unmet {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--mics-border);
}

@media (min-width: 1100px) {
  .inspector__columns {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
