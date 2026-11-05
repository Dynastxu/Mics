<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePluginContext, useSettingsExtensions } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsPage, SettingsRow } from '@mics/ui'
import type { JavaPathStatus, LaunchSettings, RepeatLaunchBehavior } from '../shared'
import {
  DEFAULT_SETTINGS,
  MAX_MEMORY_MB,
  MAX_WINDOW_SIZE,
  MIN_MEMORY_MB,
  MIN_WINDOW_SIZE,
  normalizeMemoryMb,
  normalizeWindowSize
} from '../settings'

const ctx = usePluginContext()
const extensions = useSettingsExtensions('settings.launch')

const loading = ref(true)
const error = ref('')
const javaNotice = ref('')
const adding = ref(false)
const detecting = ref(false)

const repeatBehavior = ref<RepeatLaunchBehavior>(DEFAULT_SETTINGS.repeatBehavior)
const memory = ref(String(DEFAULT_SETTINGS.maxMemory))
const windowWidth = ref(String(DEFAULT_SETTINGS.windowWidth))
const windowHeight = ref(String(DEFAULT_SETTINGS.windowHeight))
const jvmArgs = ref(DEFAULT_SETTINGS.jvmArgs)

/** 候选 Java 路径（bin 目录）：按顺序尝试；为空时启动前自动检测本机 Java */
const javaPaths = ref<string[]>([])
const javaInput = ref('')
const javaStatuses = ref<JavaPathStatus[]>([])

const javaIsEmpty = computed(() => javaPaths.value.length === 0)

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function apply(settings: LaunchSettings): void {
  repeatBehavior.value = settings.repeatBehavior
  memory.value = String(settings.maxMemory)
  javaPaths.value = settings.javaPaths
  windowWidth.value = String(settings.windowWidth)
  windowHeight.value = String(settings.windowHeight)
  jvmArgs.value = settings.jvmArgs
}

/**
 * 保存部分设置并返回服务端归一化后的完整设置。
 *
 * 调用方只回写自己负责的字段：整份 apply 会覆盖其它还未失焦提交的输入。
 */
async function save(params: Partial<LaunchSettings>): Promise<LaunchSettings | null> {
  error.value = ''
  try {
    return await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', params)
  } catch (cause) {
    error.value = messageOf(cause)
    return null
  }
}

async function load(): Promise<void> {
  try {
    apply(await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get'))
  } catch {
    /* 读取失败时使用默认值，保存仍然可用 */
  } finally {
    loading.value = false
  }
  await refreshJavaStatuses()
}

/** 刷新每个候选路径的版本信息；失败时只影响版本标签，列表本身仍然可用 */
async function refreshJavaStatuses(): Promise<void> {
  if (javaPaths.value.length === 0) {
    javaStatuses.value = []
    return
  }
  try {
    // 一定传普通数组：Vue 的响应式 Proxy 无法通过 Electron IPC 的结构化克隆
    javaStatuses.value = await ctx.ipc.invoke<JavaPathStatus[]>('mics.launch', 'java/inspect', {
      paths: [...javaPaths.value]
    })
  } catch {
    javaStatuses.value = []
  }
}

function statusOf(path: string): JavaPathStatus | null {
  return javaStatuses.value.find((entry) => entry.path.toLowerCase() === path.toLowerCase()) ?? null
}

async function saveBehavior(): Promise<void> {
  const settings = await save({ repeatBehavior: repeatBehavior.value })
  if (settings) repeatBehavior.value = settings.repeatBehavior
}

async function saveMemory(): Promise<void> {
  memory.value = String(normalizeMemoryMb(memory.value))
  const settings = await save({ maxMemory: Number(memory.value) })
  if (settings) memory.value = String(settings.maxMemory)
}

async function saveWindowWidth(): Promise<void> {
  windowWidth.value = String(normalizeWindowSize(windowWidth.value, DEFAULT_SETTINGS.windowWidth))
  const settings = await save({ windowWidth: Number(windowWidth.value) })
  if (settings) windowWidth.value = String(settings.windowWidth)
}

async function saveWindowHeight(): Promise<void> {
  windowHeight.value = String(
    normalizeWindowSize(windowHeight.value, DEFAULT_SETTINGS.windowHeight)
  )
  const settings = await save({ windowHeight: Number(windowHeight.value) })
  if (settings) windowHeight.value = String(settings.windowHeight)
}

async function saveJvmArgs(): Promise<void> {
  const settings = await save({ jvmArgs: jvmArgs.value })
  if (settings) jvmArgs.value = settings.jvmArgs
}

async function persistJavaPaths(paths: string[]): Promise<boolean> {
  const settings = await save({ javaPaths: paths })
  if (!settings) return false
  javaPaths.value = settings.javaPaths
  await refreshJavaStatuses()
  return true
}

/** 同一个可执行文件可能被主页和 bin 目录两种写法重复添加 */
function isKnownJava(status: JavaPathStatus): boolean {
  const name = status.java?.toLowerCase()
  if (javaPaths.value.some((path) => path.toLowerCase() === status.path.toLowerCase())) return true
  if (!name) return false
  return statusesMatch(name)
}

function statusesMatch(java: string): boolean {
  return javaStatuses.value.some((entry) => entry.java?.toLowerCase() === java)
}

async function addJavaPath(): Promise<void> {
  const value = javaInput.value.trim()
  if (!value || adding.value) return

  error.value = ''
  javaNotice.value = ''
  adding.value = true
  try {
    const [status] = await ctx.ipc.invoke<JavaPathStatus[]>('mics.launch', 'java/inspect', {
      paths: [value]
    })
    if (!status || status.major === null) throw new Error(`未找到可用的 Java：${value}`)
    if (isKnownJava(status)) throw new Error('该 Java 已在候选列表里')
    if (!(await persistJavaPaths([...javaPaths.value, value]))) return
    javaInput.value = ''
    javaNotice.value = `已添加 Java ${status.major}`
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    adding.value = false
  }
}

async function removeJavaPath(index: number): Promise<void> {
  error.value = ''
  javaNotice.value = ''
  await persistJavaPaths(javaPaths.value.filter((_, position) => position !== index))
}

/** 扫描本机 Java 并补进候选列表；已有的条目保持原有顺序 */
async function detectJava(): Promise<void> {
  if (detecting.value) return

  error.value = ''
  javaNotice.value = ''
  detecting.value = true
  try {
    // 先刷新已有条目的状态：JVM 可能在页面打开后被重装 / 移动，
    // 否则同一个 Java 会以「主页 vs bin 目录」两种写法重复入列
    await refreshJavaStatuses()
    const found = await ctx.ipc.invoke<JavaPathStatus[]>('mics.launch', 'java/detect')
    if (found.length === 0) {
      javaNotice.value = '未检测到本机 Java'
      return
    }

    const existingPaths = new Set(javaPaths.value.map((path) => path.toLowerCase()))
    // 同一个 JVM 可能同时出现在 PATH 与 JAVA_HOME 里（符号链接已由主进程归一化），
    // 这一批里先按可执行文件去重，避免一次检测加入两条同款
    const freshJava = new Set<string>()
    const fresh = found.filter((status) => {
      if (existingPaths.has(status.path.toLowerCase())) return false
      const name = status.java?.toLowerCase()
      if (!name) return true
      if (statusesMatch(name) || freshJava.has(name)) return false
      freshJava.add(name)
      return true
    })
    if (fresh.length === 0) {
      javaNotice.value = `检测到 ${found.length} 个 Java，均已在候选列表里`
      return
    }

    const next = [...javaPaths.value, ...fresh.map((status) => status.path)]
    if (!(await persistJavaPaths(next))) return
    javaNotice.value = `已添加 ${fresh.length} 个 Java`
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    detecting.value = false
  }
}

onMounted(load)
</script>

<template>
  <SettingsPage title="启动设置" :loading="loading" :error="error" :extensions="extensions">
    <SettingsGroup title="启动行为">
      <SettingsRow
        label="重复启动行为"
        hint="实例已在运行时再次点击开始游戏"
        html-for="launch-repeat-behavior"
      >
        <select
          id="launch-repeat-behavior"
          v-model="repeatBehavior"
          class="mics-select"
          @change="saveBehavior"
        >
          <option value="prompt">提示</option>
          <option value="launch">启动</option>
          <option value="ignore">忽略</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label="最大内存"
        :hint="`单位 MB，范围 ${MIN_MEMORY_MB}–${MAX_MEMORY_MB}`"
        html-for="launch-memory"
      >
        <input
          id="launch-memory"
          v-model="memory"
          class="mics-input"
          inputmode="numeric"
          placeholder="4096"
          @change="saveMemory"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      title="Java"
      description="按顺序尝试，使用第一个满足游戏版本要求的 Java；列表为空时启动前自动检测"
      :form="false"
    >
      <template #actions>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="detecting"
          @click="detectJava"
        >
          {{ detecting ? '检测中…' : '自动检测' }}
        </button>
      </template>

      <div class="mics-list">
        <div class="java-add">
          <input
            v-model="javaInput"
            class="mics-input"
            placeholder="java.exe、Java 主目录或 bin 目录"
            aria-label="添加 Java 路径"
            @keydown.enter.prevent="addJavaPath"
          />
          <button
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="adding || !javaInput.trim()"
            @click="addJavaPath"
          >
            {{ adding ? '检测中…' : '添加' }}
          </button>
        </div>

        <div v-if="javaIsEmpty" class="mics-empty">尚未添加；启动时自动检测本机 Java</div>

        <div v-for="(path, index) in javaPaths" :key="path" class="java-path">
          <span class="java-path__order">{{ index + 1 }}</span>
          <span class="java-path__path mics-mono" :title="statusOf(path)?.java ?? path">
            {{ path }}
          </span>
          <span v-if="statusOf(path)?.major" class="java-path__version">
            Java {{ statusOf(path)?.major }}
          </span>
          <span
            v-else-if="statusOf(path)"
            class="java-path__version java-path__version--missing"
            title="路径解析不到可用的 java"
          >
            不可用
          </span>
          <button
            class="java-path__remove"
            type="button"
            title="移除"
            :aria-label="`移除 ${path}`"
            @click="removeJavaPath(index)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      </div>

      <p v-if="javaNotice" class="java-notice" role="status">{{ javaNotice }}</p>
    </SettingsGroup>

    <SettingsGroup title="游戏窗口与参数">
      <SettingsRow
        label="游戏窗口"
        :hint="`启动时的窗口大小（${MIN_WINDOW_SIZE}–${MAX_WINDOW_SIZE}）`"
      >
        <input
          v-model="windowWidth"
          class="mics-input settings-number"
          inputmode="numeric"
          aria-label="窗口宽度"
          @change="saveWindowWidth"
        />
        <span class="settings-unit">×</span>
        <input
          v-model="windowHeight"
          class="mics-input settings-number"
          inputmode="numeric"
          aria-label="窗口高度"
          @change="saveWindowHeight"
        />
      </SettingsRow>

      <SettingsRow
        label="JVM 参数"
        hint="按空格拆分；含空格的参数用引号包住"
        html-for="launch-jvm-args"
      >
        <input
          id="launch-jvm-args"
          v-model="jvmArgs"
          class="mics-input"
          placeholder="-XX:+UseG1GC"
          @change="saveJvmArgs"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.java-add {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--mics-border);
}

.java-add .mics-input {
  flex: 1;
  min-width: 0;
}

.java-path {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--mics-border);
}

.java-path:last-child {
  border-bottom: 0;
}

.java-path__order {
  flex: none;
  width: 18px;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.java-path__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--mics-fg);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.java-path__version {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.java-path__version--missing {
  color: var(--mics-danger);
}

.java-path__remove {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  background: transparent;
  color: var(--mics-fg-muted);
  transition:
    border-color 0.12s ease,
    background 0.12s ease,
    color 0.12s ease;
}

.java-path__remove:hover {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, transparent);
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.java-path__remove:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.java-notice {
  margin: 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.settings-number {
  flex: none;
  width: 96px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.settings-unit {
  flex: none;
  color: var(--mics-fg-muted);
  font-size: 12px;
}
</style>
