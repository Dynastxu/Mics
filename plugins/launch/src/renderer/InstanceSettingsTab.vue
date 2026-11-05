<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { SettingsRow, ToggleSwitch } from '@mics/ui'
import type {
  InstanceJavaMode,
  InstanceLaunchSettings,
  JavaPathStatus,
  LaunchSettings
} from '../shared'
import {
  DEFAULT_INSTANCE_SETTINGS,
  MAX_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowSize,
  samePath
} from '../settings'

const props = defineProps<{
  instanceId: string
  /** 该实例版本要求的 Java 主版本；候选里低于它的一律不展示 */
  requiredJava: number
}>()

const ctx = usePluginContext()

const loading = ref(true)
const loadFailed = ref(false)
const error = ref('')
const saving = ref(false)
const settings = ref<InstanceLaunchSettings>({ ...DEFAULT_INSTANCE_SETTINGS })
/** 全局值：跟随全局时直接展示，避免用户为了看一眼再去设置页 */
const global = ref<Pick<LaunchSettings, 'windowWidth' | 'windowHeight' | 'jvmArgs'> | null>(null)
const javaChoices = ref<JavaPathStatus[]>([])
const javaPath = ref('')
const jvmArgs = ref('')
const windowWidth = ref(String(DEFAULT_INSTANCE_SETTINGS.windowWidth))
const windowHeight = ref(String(DEFAULT_INSTANCE_SETTINGS.windowHeight))

/** 下拉框只列出满足版本要求的 Java；已失效 / 已选中的条目仍然保留，便于用户改选 */
const javaOptions = computed(() =>
  javaChoices.value.filter(
    (choice) =>
      choice.major === null ||
      choice.major >= props.requiredJava ||
      samePath(choice.path, settings.value.javaPath)
  )
)

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function apply(value: InstanceLaunchSettings): void {
  settings.value = value
  javaPath.value = value.javaPath
  jvmArgs.value = value.jvmArgs
  windowWidth.value = String(value.windowWidth)
  windowHeight.value = String(value.windowHeight)
}

/** 保存过的 Java 不在本次检测结果里时，单独补一条，保证下拉框能显示当前值 */
async function ensureJavaChoice(path: string): Promise<void> {
  if (javaChoices.value.some((choice) => samePath(choice.path, path))) return

  let status: JavaPathStatus | null = null
  try {
    const [inspected] = await ctx.ipc.invoke<JavaPathStatus[]>('mics.launch', 'java/inspect', {
      paths: [path]
    })
    status = inspected ?? null
  } catch {
    /* 版本标签拿不到不影响选择本身 */
  }

  javaChoices.value = [...javaChoices.value, status ?? { path, java: null, major: null }]
}

async function load(): Promise<void> {
  loading.value = true
  loadFailed.value = false
  error.value = ''
  try {
    const [instanceSettings, globalSettings, detected] = await Promise.all([
      ctx.ipc.invoke<InstanceLaunchSettings>('mics.launch', 'instances/settings', {
        id: props.instanceId
      }),
      ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get'),
      ctx.ipc
        .invoke<JavaPathStatus[]>('mics.launch', 'java/detect')
        .catch(() => [] as JavaPathStatus[])
    ])

    apply(instanceSettings)
    global.value = {
      windowWidth: globalSettings.windowWidth,
      windowHeight: globalSettings.windowHeight,
      jvmArgs: globalSettings.jvmArgs
    }

    // 下拉框同时给出「本机检测到的 Java」和「全局候选里不在标准位置的 Java」
    const extra = globalSettings.javaPaths.filter(
      (path) => !detected.some((choice) => samePath(choice.path, path))
    )
    let extras: JavaPathStatus[] = []
    if (extra.length > 0) {
      try {
        extras = await ctx.ipc.invoke<JavaPathStatus[]>('mics.launch', 'java/inspect', {
          paths: [...extra]
        })
      } catch {
        /* 全局候选无法解析时只少几个选项，不影响实例设置 */
      }
    }
    javaChoices.value = [...detected, ...extras]

    if (instanceSettings.javaPath) await ensureJavaChoice(instanceSettings.javaPath)
  } catch (cause) {
    loadFailed.value = true
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function save(
  patch: Partial<InstanceLaunchSettings>
): Promise<InstanceLaunchSettings | null> {
  if (saving.value) return null
  error.value = ''
  saving.value = true
  try {
    const saved = await ctx.ipc.invoke<InstanceLaunchSettings>(
      'mics.launch',
      'instances/settings/set',
      { id: props.instanceId, ...patch }
    )
    settings.value = saved
    return saved
  } catch (cause) {
    error.value = messageOf(cause)
    return null
  } finally {
    saving.value = false
  }
}

async function chooseJavaMode(mode: InstanceJavaMode): Promise<void> {
  if (saving.value || settings.value.javaMode === mode) return

  if (mode === 'auto') {
    await save({ javaMode: 'auto' })
    return
  }

  // 指定时必须带一个能用的 Java：优先保留已经选好的，其次取第一个满足版本要求的
  const usable = (choice: JavaPathStatus): boolean =>
    choice.major !== null && choice.major >= props.requiredJava
  const current = javaChoices.value.find(
    (choice) => usable(choice) && samePath(choice.path, javaPath.value)
  )
  const candidate = current ?? javaChoices.value.find(usable)
  if (!candidate) {
    error.value =
      javaChoices.value.length > 0
        ? `没有满足 Java ${props.requiredJava} 要求的 Java，请先在「设置 → 启动设置」里添加`
        : '未检测到可用的 Java，请先在「设置 → 启动设置」里添加'
    return
  }

  javaPath.value = candidate.path
  const saved = await save({ javaMode: 'specified', javaPath: candidate.path })
  if (saved) await ensureJavaChoice(saved.javaPath)
}

async function selectJava(): Promise<void> {
  const previous = settings.value.javaPath
  const selected = javaPath.value
  const saved = await save({ javaPath: selected })
  if (!saved) {
    javaPath.value = previous
    return
  }
  javaPath.value = saved.javaPath
  await ensureJavaChoice(saved.javaPath)
}

async function setFollowJvmArgs(value: boolean): Promise<void> {
  await save({ followGlobalJvmArgs: value })
}

async function saveJvmArgs(): Promise<void> {
  const saved = await save({ jvmArgs: jvmArgs.value })
  if (saved) jvmArgs.value = saved.jvmArgs
}

async function setFollowWindow(value: boolean): Promise<void> {
  await save({ followGlobalWindow: value })
}

async function saveWindowWidth(): Promise<void> {
  windowWidth.value = String(normalizeWindowSize(windowWidth.value, settings.value.windowWidth))
  const saved = await save({ windowWidth: Number(windowWidth.value) })
  if (saved) windowWidth.value = String(saved.windowWidth)
}

async function saveWindowHeight(): Promise<void> {
  windowHeight.value = String(normalizeWindowSize(windowHeight.value, settings.value.windowHeight))
  const saved = await save({ windowHeight: Number(windowHeight.value) })
  if (saved) windowHeight.value = String(saved.windowHeight)
}

onMounted(load)
</script>

<template>
  <section class="instance-settings">
    <p v-if="error" class="mics-notice">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取实例设置…</div>
    <div v-else-if="loadFailed" class="mics-empty">
      无法读取实例设置
      <button class="mics-empty__action" type="button" @click="load">重试</button>
    </div>

    <div v-else class="mics-form">
      <SettingsRow
        label="Java"
        :hint="`该版本需要 Java ${requiredJava} 或更高；自动：按全局候选列表选择`"
        wide
      >
        <div class="instance-settings__choice" role="group" aria-label="Java 选择">
          <button
            type="button"
            class="instance-settings__option"
            :class="{ 'is-active': settings.javaMode === 'auto' }"
            :aria-pressed="settings.javaMode === 'auto'"
            :disabled="saving"
            @click="chooseJavaMode('auto')"
          >
            自动
          </button>
          <button
            type="button"
            class="instance-settings__option"
            :class="{ 'is-active': settings.javaMode === 'specified' }"
            :aria-pressed="settings.javaMode === 'specified'"
            :disabled="saving"
            @click="chooseJavaMode('specified')"
          >
            指定
          </button>
        </div>

        <select
          v-if="settings.javaMode === 'specified'"
          v-model="javaPath"
          class="mics-select instance-settings__java"
          :disabled="saving"
          aria-label="指定 Java"
          @change="selectJava"
        >
          <option
            v-for="choice in javaOptions"
            :key="choice.path"
            :value="choice.path"
            :disabled="choice.major === null && !samePath(choice.path, settings.javaPath)"
          >
            {{ choice.major ? `Java ${choice.major}` : '不可用' }} · {{ choice.path }}
          </option>
        </select>
      </SettingsRow>

      <SettingsRow label="JVM 参数" hint="启动该实例时额外追加的 JVM 参数">
        <input
          v-if="!settings.followGlobalJvmArgs"
          v-model="jvmArgs"
          class="mics-input"
          placeholder="-XX:+UseG1GC"
          spellcheck="false"
          @change="saveJvmArgs"
        />
        <span v-else class="mics-muted instance-settings__value" :title="global?.jvmArgs ?? ''">
          {{ global?.jvmArgs || '未设置' }}
        </span>

        <template #actions>
          <span class="instance-settings__toggle-label">跟随全局</span>
          <ToggleSwitch
            :model-value="settings.followGlobalJvmArgs"
            :disabled="saving"
            label="JVM 参数跟随全局"
            @update:model-value="setFollowJvmArgs"
          />
        </template>
      </SettingsRow>

      <SettingsRow
        label="游戏窗口"
        :hint="`启动该实例时的窗口大小（${MIN_WINDOW_SIZE}–${MAX_WINDOW_SIZE}）`"
      >
        <template v-if="!settings.followGlobalWindow">
          <input
            v-model="windowWidth"
            class="mics-input instance-settings__number"
            inputmode="numeric"
            aria-label="窗口宽度"
            @change="saveWindowWidth"
          />
          <span class="mics-muted">×</span>
          <input
            v-model="windowHeight"
            class="mics-input instance-settings__number"
            inputmode="numeric"
            aria-label="窗口高度"
            @change="saveWindowHeight"
          />
        </template>
        <span v-else class="mics-muted instance-settings__value">
          {{ global ? `${global.windowWidth} × ${global.windowHeight}` : '跟随全局' }}
        </span>

        <template #actions>
          <span class="instance-settings__toggle-label">跟随全局</span>
          <ToggleSwitch
            :model-value="settings.followGlobalWindow"
            :disabled="saving"
            label="游戏窗口跟随全局"
            @update:model-value="setFollowWindow"
          />
        </template>
      </SettingsRow>
    </div>
  </section>
</template>

<style scoped>
.instance-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.instance-settings__choice {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  background: var(--mics-bg);
}

.instance-settings__option {
  height: 26px;
  padding: 0 14px;
  border-radius: 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.instance-settings__option:hover {
  color: var(--mics-fg);
}

.instance-settings__option.is-active {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.instance-settings__option:disabled {
  opacity: 0.55;
}

.instance-settings__option:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.mics-field__control .instance-settings__java {
  flex: 1;
  min-width: 240px;
  max-width: none;
}

.mics-field__control .instance-settings__number {
  flex: none;
  width: 96px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.instance-settings__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-settings__toggle-label {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}
</style>
