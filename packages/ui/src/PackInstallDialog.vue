<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { InstanceSaves, InstanceSummary, PackKind } from '@mics/sdk'
import Dialog from './Dialog.vue'

/**
 * 「把资源包装进实例」的通用弹窗。
 *
 * 资源包 / 光影包可以多选实例；数据包是存档级内容，只能选一个实例 + 一个存档。
 * 组件只负责选择与兼容性提示，实例列表与存档查询由页面通过 props 注入。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    kind: PackKind
    packName: string
    fileName?: string
    /** 该版本支持的游戏版本；为空表示不限制 */
    gameVersions?: string[]
    instances: InstanceSummary[]
    loading?: boolean
    installing?: boolean
    error?: string
    /** 数据包必须提供：按实例读取存档列表 */
    fetchSaves?: (instanceId: string) => Promise<InstanceSaves>
  }>(),
  {
    fileName: '',
    gameVersions: () => [],
    loading: false,
    installing: false,
    error: ''
  }
)

const emit = defineEmits<{
  close: []
  install: [payload: { instanceNames: string[]; worldName?: string }]
}>()

const selected = ref<string[]>([])
const selectedWorld = ref('')
const saves = ref<InstanceSaves | null>(null)
const savesLoading = ref(false)
const savesError = ref('')
const showUnsupported = ref(false)
let savesSequence = 0

const single = computed(() => props.kind === 'datapack')
const title = computed(() => (single.value ? '选择实例与存档' : '选择实例'))
const subtitle = computed(() => [props.packName, props.fileName].filter(Boolean).join(' · '))

const instanceById = computed(
  () => new Map(props.instances.map((instance) => [instance.id, instance]))
)

/** 返回不可安装的原因；空串表示可以安装 */
function incompatibleReason(instance: InstanceSummary): string {
  if (instance.installState !== 'ready') return '安装未完成'
  if (props.gameVersions.length > 0 && !props.gameVersions.includes(instance.minecraft)) {
    return `需要 ${props.gameVersions.join(' / ')}`
  }
  return ''
}

const compatible = computed(() =>
  props.instances.filter((instance) => !incompatibleReason(instance))
)
const unsupportedCount = computed(() => props.instances.length - compatible.value.length)

/** 默认只列出支持的实例；打开开关后才把不支持的实例放出来强行安装 */
const visible = computed(() => (showUnsupported.value ? props.instances : compatible.value))

const selectedInstance = computed(() => instanceById.value.get(selected.value[0] ?? '') ?? null)

const worldOptions = computed(() => saves.value?.entries ?? [])

const canInstall = computed(() => {
  if (props.installing || props.loading) return false
  if (selected.value.length === 0) return false
  if (single.value) return Boolean(selectedWorld.value)
  return true
})

/** 关掉开关时把已勾选的不支持实例一并取消，避免隐藏项仍被安装 */
const showUnsupportedModel = computed({
  get: () => showUnsupported.value,
  set: (value: boolean) => {
    showUnsupported.value = value
    if (value) return
    const allowed = new Set(compatible.value.map((instance) => instance.id))
    selected.value = selected.value.filter((id) => allowed.has(id))
    if (single.value && selected.value.length === 0) {
      selectedWorld.value = ''
      saves.value = null
    }
  }
})

const allSelected = computed(
  () =>
    !single.value &&
    visible.value.length > 0 &&
    visible.value.every((instance) => selected.value.includes(instance.id))
)

function formatDate(timestamp: number): string {
  if (!timestamp) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp))
}

async function loadSaves(instanceId: string): Promise<void> {
  const sequence = ++savesSequence
  saves.value = null
  selectedWorld.value = ''
  savesError.value = ''

  if (!props.fetchSaves) {
    savesError.value = '无法读取存档列表'
    return
  }

  savesLoading.value = true
  try {
    const result = await props.fetchSaves(instanceId)
    if (sequence === savesSequence) saves.value = result
  } catch (cause) {
    if (sequence === savesSequence) {
      savesError.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    if (sequence === savesSequence) savesLoading.value = false
  }
}

function selectInstance(id: string): void {
  if (single.value) {
    if (selected.value[0] === id) return
    selected.value = [id]
    void loadSaves(id)
    return
  }

  const index = selected.value.indexOf(id)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(id)
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : visible.value.map((instance) => instance.id)
}

function reset(): void {
  selected.value = []
  selectedWorld.value = ''
  saves.value = null
  savesError.value = ''
  savesLoading.value = false
  showUnsupported.value = false
  savesSequence += 1
}

function install(): void {
  if (!canInstall.value) return
  emit('install', {
    instanceNames: [...selected.value],
    ...(single.value ? { worldName: selectedWorld.value } : {})
  })
}

function close(): void {
  if (props.installing) return
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
  { immediate: true }
)
</script>

<template>
  <Dialog :open="open" :title="title" :subtitle="subtitle" @close="close">
    <div class="pack-install">
      <p v-if="error" class="mics-notice mics-notice--error">{{ error }}</p>

      <div v-if="loading" class="mics-empty">正在读取实例…</div>

      <div v-else-if="instances.length === 0" class="mics-empty">
        还没有可用实例，请先在「原版」页安装一个实例。
      </div>

      <div v-else-if="visible.length === 0" class="mics-empty">没有支持的实例</div>

      <div v-else class="pack-install__list">
        <label v-for="instance in visible" :key="instance.id" class="pack-instance">
          <input
            :type="single ? 'radio' : 'checkbox'"
            :name="single ? 'pack-install-instance' : undefined"
            class="pack-instance__check"
            :checked="selected.includes(instance.id)"
            :disabled="installing"
            @change="selectInstance(instance.id)"
          />
          <span class="pack-instance__main">
            <span class="pack-instance__name">{{ instance.name }}</span>
            <span class="pack-instance__meta">
              {{ instance.minecraft }} · {{ instance.loader }} · {{ instance.mods }} 个 Mod
            </span>
          </span>
          <span v-if="incompatibleReason(instance)" class="pack-instance__reason">
            {{ incompatibleReason(instance) }}
          </span>
        </label>
      </div>

      <p v-if="kind === 'shader'" class="pack-install__hint">
        光影包需要实例安装 Iris 或 OptiFine；文件放进 shaderpacks 后，进游戏在「光影」里启用。
      </p>

      <section v-if="single && selectedInstance" class="pack-install__saves">
        <h2 class="mics-section__title">选择存档</h2>

        <div v-if="savesLoading" class="mics-empty">正在读取存档…</div>
        <p v-else-if="savesError" class="mics-notice mics-notice--error">{{ savesError }}</p>
        <div v-else-if="worldOptions.length === 0" class="mics-empty">
          该实例还没有存档。请先启动游戏创建一个世界，再回来安装数据包。
        </div>
        <div v-else class="pack-save__list">
          <label v-for="world in worldOptions" :key="world.id" class="pack-save">
            <input
              v-model="selectedWorld"
              type="radio"
              name="pack-install-world"
              class="pack-instance__check"
              :value="world.id"
              :disabled="installing"
            />
            <span class="pack-instance__main">
              <span class="pack-instance__name">{{ world.name }}</span>
              <span class="pack-instance__meta">
                {{ formatDate(world.modified) }} · 数据包 {{ world.datapacks }} 个
              </span>
            </span>
          </label>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="pack-install__left">
        <button
          v-if="!single && visible.length > 0"
          class="mics-button mics-button--ghost mics-button--small"
          type="button"
          :disabled="installing"
          @click="toggleAll"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <label v-if="unsupportedCount > 0" class="pack-install__toggle">
          <input
            v-model="showUnsupportedModel"
            type="checkbox"
            class="pack-instance__check"
            :disabled="installing"
          />
          显示不支持的实例 ({{ unsupportedCount }})
        </label>
        <span v-if="!single && visible.length > 0" class="pack-install__count">
          已选 {{ selected.length }} / {{ visible.length }}
        </span>
        <span v-else-if="selectedInstance" class="pack-install__count">
          {{ selectedInstance.name }}{{ selectedWorld ? ` · ${selectedWorld}` : '' }}
        </span>
      </div>

      <div class="pack-install__actions">
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
          :disabled="installing || !canInstall"
          @click="install"
        >
          {{ installing ? '提交中…' : `安装 (${selected.length})` }}
        </button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.pack-install {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
}

.pack-install__list,
.pack-save__list {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--mics-border);
  border-radius: 9px;
}

.pack-install__list {
  flex: 1 1 auto;
  min-height: 0;
}

.pack-instance,
.pack-save {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mics-border);
  cursor: pointer;
  transition: background 0.12s ease;
}

.pack-instance:last-child,
.pack-save:last-child {
  border-bottom: 0;
}

.pack-instance:hover,
.pack-save:hover {
  background: var(--mics-bg-hover);
}

.pack-instance__check {
  flex: none;
  width: 14px;
  height: 14px;
  accent-color: var(--mics-accent);
}

.pack-instance__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pack-instance__name {
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pack-instance__meta {
  color: var(--mics-fg-muted);
  font-size: 11px;
}

.pack-instance__reason {
  flex: none;
  max-width: 42%;
  color: var(--mics-fg-muted);
  font-size: 10.5px;
  text-align: right;
}

.pack-install__hint {
  margin: 10px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11px;
  line-height: 1.5;
}

.pack-install__saves {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.pack-install__saves .mics-section__title {
  margin: 0;
}

.pack-install__left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}

.pack-install__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.pack-install__toggle:hover {
  color: var(--mics-fg);
}

.pack-install__count {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.pack-install__actions {
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
