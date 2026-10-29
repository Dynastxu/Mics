<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { pluginIdOf } from '@mics/sdk'
import type {
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

const ctx = usePluginContext()
const selfId = pluginIdOf(ctx)
const installing = ref(false)
const error = ref('')
const busy = ref<Record<string, boolean>>({})
const failure = ref<Extract<PluginUninstallOutcome, { status: 'failed' }> | undefined>()
const graph = ref<PluginGraphReport>()
const graphError = ref('')
const selectedId = ref<PluginId>('')
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
const scanIssues = computed(() => graph.value?.scanIssues ?? [])
const unmetOfSelected = computed(() =>
  (graph.value?.unmet ?? []).filter((item) => item.neededBy.includes(selectedId.value)),
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
      { value: 'waiting', label: '等待依赖' },
      { value: 'disabled', label: '已禁用' },
      { value: 'failed', label: '失败' },
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
      capability(plugin),
      statusLabel(plugin),
      plugin.waitingFor?.length ? `等待：${plugin.waitingFor.join('、')}` : '',
      plugin.dependencyIssues?.length ? `依赖：${plugin.dependencyIssues.join('；')}` : '',
      plugin.failure ? failureText(plugin) : '',
    ].filter(Boolean)
    return {
      id: plugin.id,
      label: plugin.name,
      badges: [
        { label: plugin.source === 'builtin' ? '内置' : '第三方' },
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
  if (plugin.status === 'waiting') return '等待依赖'
  return plugin.status === 'disabled' ? '已禁用' : '已启用'
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
  // 内核状态变化时重取诊断；页面不自己推断依赖关系
  stopGraphWatch = ctx.plugins.onDidChange(() => {
    void loadGraph()
  })
})

onBeforeUnmount(() => {
  stopGraphWatch?.()
})
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
    <p v-if="graphError" class="inspector__error">诊断读取失败：{{ graphError }}</p>

    <div v-if="scanIssues.length" class="inspector__issue">
      <strong>{{ scanIssues.length }} 个插件目录无法加载</strong>
      <ul>
        <li v-for="issue in scanIssues" :key="issue.dir">
          <span class="mics-mono">{{ issue.dir }}</span>
          <span>{{ issue.errors.join('；') }}</span>
        </li>
      </ul>
    </div>

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
      role="radio"
      :selected-id="selectedId"
      search-placeholder="搜索插件"
      empty-text="没有匹配的插件"
      @select="selectPlugin"
    >
      <template #actions="{ item }">
        <div class="inspector__actions" @click.stop>
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

    <section v-if="selectedNode" class="inspector__detail">
      <header class="inspector__detail-head">
        <div>
          <h2 class="inspector__detail-title">{{ selectedNode.name }}</h2>
          <p class="inspector__detail-meta mics-mono">
            {{ selectedNode.id }} · v{{ selectedNode.version }} ·
            {{ statusLabelOf(selectedNode.status) }}
          </p>
        </div>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          @click="selectedId = ''"
        >
          关闭
        </button>
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

      <div v-if="selectedNode.warnings.length" class="inspector__notice">
        {{ selectedNode.warnings.join('；') }}
      </div>

      <div class="inspector__columns">
        <section class="inspector__column">
          <h3>我依赖</h3>
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
          <h3>依赖我</h3>
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
          <h3>我提供</h3>
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
          <h3>我注册</h3>
          <ul v-if="selectedNode.contributes.length">
            <li v-for="item in selectedNode.contributes" :key="`${item.kind}:${item.id}`">
              {{ contributionText(item) }}
            </li>
          </ul>
          <p v-else class="inspector__muted">无</p>
        </section>
      </div>

      <div v-if="unmetOfSelected.length" class="inspector__unmet">
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
.inspector__unmet h3 {
  margin: 0 0 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  font-weight: 600;
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
