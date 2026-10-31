<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MOD_LOADER_LABELS } from '@mics/sdk'
import type {
  InstallStartResult,
  InstanceSummary,
  ModLoader,
} from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'
import { Dialog } from '@mics/ui'

/** 只依赖安装真正需要的字段，Mod / 整合包等目录条目都能直接传入 */
interface InstallableVersion {
  name: string
  fileName: string
  fileUrl: string
  sha1: string
  size: number
  loaders: string[]
  gameVersions: string[]
}

const props = defineProps<{
  open: boolean
  version: InstallableVersion | null
}>()

const emit = defineEmits<{
  close: []
  /** 下载任务已受理；jobId 与本次选择的实例数交给调用方提示 */
  started: [jobId: string, instanceCount: number]
}>()

const ctx = usePluginContext()

const instances = ref<InstanceSummary[]>([])
const selected = ref<string[]>([])
const showAllInstances = ref(false)
const loading = ref(false)
const installing = ref(false)
const error = ref('')
let loadSeq = 0

const instanceById = computed(
  () => new Map(instances.value.map((instance) => [instance.id, instance])),
)

/** 返回不可安装的原因；空串表示可以安装 */
function incompatibleReason(instance: InstanceSummary): string {
  const version = props.version
  if (instance.installState !== 'ready') return '安装未完成'
  if (instance.loader === '原版') return '原版实例'
  if (!version) return '未选择文件'

  if (version.loaders.length > 0) {
    const allowed = version.loaders.map((loader) => MOD_LOADER_LABELS[loader as ModLoader] ?? loader)
    if (!allowed.includes(instance.loader)) return `需要 ${allowed.join(' / ')}`
  }
  if (version.gameVersions.length > 0 && !version.gameVersions.includes(instance.minecraft)) {
    return `需要 ${version.gameVersions.join(' / ')}`
  }
  return ''
}

const compatible = computed(() =>
  instances.value.filter((instance) => !incompatibleReason(instance)),
)
const unsupportedCount = computed(() => instances.value.length - compatible.value.length)

/** 默认只列出支持的实例；打开开关后才把不支持的实例放出来强行安装 */
const visible = computed(() => (showAllInstances.value ? instances.value : compatible.value))

/** 关掉开关时把已勾选的不支持实例一并取消，避免隐藏项仍被安装 */
const showUnsupported = computed({
  get: () => showAllInstances.value,
  set: (value: boolean) => {
    showAllInstances.value = value
    if (value) return
    const allowed = new Set(compatible.value.map((instance) => instance.id))
    selected.value = selected.value.filter((id) => allowed.has(id))
  },
})

const allSelected = computed(
  () =>
    visible.value.length > 0 &&
    visible.value.every((instance) => selected.value.includes(instance.id)),
)

function toggle(id: string): void {
  const instance = instanceById.value.get(id)
  if (!instance) return
  const index = selected.value.indexOf(id)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(id)
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : visible.value.map((instance) => instance.id)
}

async function loadInstances(seq: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    // 启动插件是懒激活的：实例选择器第一次打开时再把它拉起来，
    // 这样禁用启动插件只会影响安装，不会让整个 Mod 目录打不开。
    await ctx.plugins.activate('mics.launch')
    const list = await ctx.ipc.invoke<InstanceSummary[]>('mics.launch', 'instances/list')
    if (seq === loadSeq) instances.value = list
  } catch (cause) {
    if (seq === loadSeq) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function install(): Promise<void> {
  const version = props.version
  if (!version || installing.value || selected.value.length === 0) return
  installing.value = true
  error.value = ''
  try {
    // Vue 的数组是响应式 Proxy，Electron IPC 的结构化克隆无法复制；
    // 传参前必须转成普通数组，否则会报 "An object could not be cloned."
    const instanceNames = [...selected.value]
    const outcome = await ctx.ipc.invoke<InstallStartResult>(
      'mics.download.manager',
      'mods/install',
      {
        file: {
          url: version.fileUrl,
          fileName: version.fileName,
          sha1: version.sha1,
          size: version.size,
        },
        instanceNames,
        title: version.name,
        detail: `${instanceNames.length} 个实例`,
      },
    )
    if (outcome.error) {
      error.value = outcome.error
      return
    }
    emit('started', outcome.jobId, instanceNames.length)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    installing.value = false
  }
}

function close(): void {
  if (installing.value) return
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    const seq = ++loadSeq
    if (!open) return
    selected.value = []
    showAllInstances.value = false
    error.value = ''
    instances.value = []
    void loadInstances(seq)
  },
)
</script>

<template>
  <Dialog
    :open="open"
    title="选择实例"
    :subtitle="version ? `${version.name}${version.fileName ? ` · ${version.fileName}` : ''}` : ''"
    @close="close"
  >
    <p v-if="error" class="mics-notice mics-notice--error">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取实例…</div>

    <div v-else-if="instances.length === 0" class="mics-empty">
      还没有可用实例，请先在「原版」页安装一个带模组加载器的实例。
    </div>

    <div v-else-if="visible.length === 0" class="mics-empty">没有支持的实例</div>

    <div v-else class="install-dialog__list">
      <label
        v-for="instance in visible"
        :key="instance.id"
        class="install-instance"
      >
        <input
          type="checkbox"
          class="install-instance__check"
          :checked="selected.includes(instance.id)"
          :disabled="installing"
          @change="toggle(instance.id)"
        />
        <span class="install-instance__main">
          <span class="install-instance__name">{{ instance.name }}</span>
          <span class="install-instance__meta">
            {{ instance.minecraft }} · {{ instance.loader }} · {{ instance.mods }} 个 Mod
          </span>
        </span>
        <span v-if="incompatibleReason(instance)" class="install-instance__reason">
          {{ incompatibleReason(instance) }}
        </span>
      </label>
    </div>

    <template #footer>
      <div class="install-dialog__left">
        <button
          v-if="visible.length > 0"
          class="mics-button mics-button--ghost mics-button--small"
          type="button"
          :disabled="installing"
          @click="toggleAll"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <label v-if="unsupportedCount > 0" class="install-dialog__toggle">
          <input
            v-model="showUnsupported"
            type="checkbox"
            class="install-instance__check"
            :disabled="installing"
          />
          显示不支持的实例 ({{ unsupportedCount }})
        </label>
        <span v-if="visible.length > 0" class="install-dialog__count">
          已选 {{ selected.length }} / {{ visible.length }}
        </span>
      </div>

      <div class="install-dialog__actions">
        <button
          class="mics-button mics-button--ghost"
          type="button"
          :disabled="installing"
          @click="close"
        >
          取消
        </button>
        <button
          class="mics-button mics-button--primary"
          type="button"
          :disabled="installing || selected.length === 0"
          @click="install"
        >
          {{ installing ? '提交中…' : `安装 (${selected.length})` }}
        </button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.install-dialog__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--mics-border);
  border-radius: 9px;
}

.install-instance {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mics-border);
  cursor: pointer;
  transition: background 0.12s ease;
}

.install-instance:last-child {
  border-bottom: 0;
}

.install-instance:hover {
  background: var(--mics-bg-hover);
}

.install-instance__check {
  flex: none;
  width: 14px;
  height: 14px;
  accent-color: var(--mics-accent);
}

.install-instance__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.install-instance__name {
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.install-instance__meta {
  color: var(--mics-fg-muted);
  font-size: 11px;
}

.install-instance__reason {
  flex: none;
  max-width: 42%;
  color: var(--mics-fg-muted);
  font-size: 10.5px;
  text-align: right;
}

.install-dialog__left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.install-dialog__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.install-dialog__toggle:hover {
  color: var(--mics-fg);
}

.install-dialog__count {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.install-dialog__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mics-notice--error {
  margin-bottom: 12px;
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}
</style>
