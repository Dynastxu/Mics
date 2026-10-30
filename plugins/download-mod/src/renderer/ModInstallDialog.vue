<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MOD_LOADER_LABELS } from '@mics/sdk'
import type {
  InstallStartResult,
  InstanceSummary,
  ModVersion,
} from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'

const props = defineProps<{
  open: boolean
  version: ModVersion | null
}>()

const emit = defineEmits<{
  close: []
  /** 下载任务已受理；jobId 与本次选择的实例数交给调用方提示 */
  started: [jobId: string, instanceCount: number]
}>()

const ctx = usePluginContext()

const instances = ref<InstanceSummary[]>([])
const selected = ref<string[]>([])
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
    const allowed = version.loaders.map((loader) => MOD_LOADER_LABELS[loader])
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
const compatibleCount = computed(() => compatible.value.length)
const allSelected = computed(
  () => compatibleCount.value > 0 && selected.value.length === compatibleCount.value,
)

function toggle(id: string): void {
  const instance = instanceById.value.get(id)
  if (!instance || incompatibleReason(instance)) return
  const index = selected.value.indexOf(id)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(id)
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : compatible.value.map((instance) => instance.id)
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
    error.value = ''
    instances.value = []
    void loadInstances(seq)
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="install-dialog"
      role="presentation"
      @click.self="close"
      @keydown.esc.stop.prevent="close"
    >
      <div
        class="install-dialog__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mod-install-dialog-title"
      >
        <header class="install-dialog__header">
          <h2 id="mod-install-dialog-title" class="install-dialog__title">选择实例</h2>
          <p class="install-dialog__subtitle">
            {{ version?.name }}<span v-if="version?.fileName"> · {{ version.fileName }}</span>
          </p>
        </header>

        <p v-if="error" class="mics-notice mics-notice--error">{{ error }}</p>

        <div v-if="loading" class="mics-empty">正在读取实例…</div>

        <div v-else-if="instances.length === 0" class="mics-empty">
          还没有可用实例，请先在「原版」页安装一个带模组加载器的实例。
        </div>

        <div v-else class="install-dialog__list">
          <label
            v-for="instance in instances"
            :key="instance.id"
            class="install-instance"
            :class="{ 'is-disabled': Boolean(incompatibleReason(instance)) }"
          >
            <input
              type="checkbox"
              class="install-instance__check"
              :checked="selected.includes(instance.id)"
              :disabled="Boolean(incompatibleReason(instance)) || installing"
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

        <footer class="install-dialog__footer">
          <div class="install-dialog__left">
            <button
              v-if="compatibleCount > 0"
              class="mics-button mics-button--ghost mics-button--small"
              type="button"
              :disabled="installing"
              @click="toggleAll"
            >
              {{ allSelected ? '取消全选' : '全选' }}
            </button>
            <span class="install-dialog__count">
              已选 {{ selected.length }} / {{ compatibleCount }}
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
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.install-dialog {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.install-dialog__box {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(640px, 86vh);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.install-dialog__header {
  margin-bottom: 14px;
}

.install-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.install-dialog__subtitle {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}

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

.install-instance.is-disabled {
  cursor: default;
  opacity: 0.55;
}

.install-instance.is-disabled:hover {
  background: transparent;
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

.install-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}

.install-dialog__left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
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
