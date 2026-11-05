<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsRow, ToggleSwitch } from '@mics/ui'
import {
  CLOSE_ACTION_OPTIONS,
  CLOSE_BEHAVIOR_CHANGED,
  DEFAULT_CLOSE_ACTION,
  DEFAULT_LOW_MEMORY_TRAY,
  isCloseAction,
  normalizeCloseAction,
  type CloseAction,
  type CloseSettings
} from '../shared'

/**
 * 这个组件由 close-behavior 自己注册到通用设置页。
 *
 * shell 在渲染追加分组时注入了注册方的作用域，因此这里拿到的就是
 * close-behavior 自己的 ctx；RPC 的 callerId 与事件监听器归属都正确。
 */
const ctx = usePluginContext()

const options = CLOSE_ACTION_OPTIONS
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const savedAction = ref<CloseAction>(DEFAULT_CLOSE_ACTION)
const savedLowMemory = ref(DEFAULT_LOW_MEMORY_TRAY)
const closeAction = ref<CloseAction>(DEFAULT_CLOSE_ACTION)
const lowMemoryTray = ref(DEFAULT_LOW_MEMORY_TRAY)
const runsInTray = computed(() => closeAction.value === 'tray')
const trayHint = computed(() =>
  lowMemoryTray.value
    ? '应用继续在后台运行；恢复时会重新加载界面。'
    : '应用继续在后台运行，可从托盘图标恢复。'
)

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function apply(settings: CloseSettings): void {
  savedAction.value = normalizeCloseAction(settings.closeAction)
  savedLowMemory.value = settings.lowMemoryTray === true
  closeAction.value = savedAction.value
  lowMemoryTray.value = savedLowMemory.value
}

async function load(): Promise<void> {
  try {
    apply(await ctx.ipc.invoke<CloseSettings>('mics.close-behavior', 'settings/get'))
    error.value = ''
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    apply(
      await ctx.ipc.invoke<CloseSettings>('mics.close-behavior', 'settings/set', {
        closeAction: closeAction.value,
        lowMemoryTray: lowMemoryTray.value
      })
    )
  } catch (cause) {
    error.value = messageOf(cause)
    closeAction.value = savedAction.value
    lowMemoryTray.value = savedLowMemory.value
  } finally {
    saving.value = false
  }
}

async function setLowMemory(value: boolean): Promise<void> {
  if (saving.value) return
  lowMemoryTray.value = value
  await save()
}

async function reset(): Promise<void> {
  closeAction.value = DEFAULT_CLOSE_ACTION
  await save()
}

let offViewActivated: (() => void) | undefined
let offChanged: (() => void) | undefined

onMounted(() => {
  // 通用页在页面栈里保持挂载：确认框勾选「不再提示」改了同一个值，重新可见时同步一次
  offViewActivated = ctx.on('ui/viewActivated', (viewId: string) => {
    if (viewId === 'settings.general') void load()
  })
  offChanged = ctx.on(CLOSE_BEHAVIOR_CHANGED, (settings) => {
    if (saving.value) return
    if (!isCloseAction(settings?.closeAction)) return
    apply({
      closeAction: settings.closeAction,
      lowMemoryTray: settings.lowMemoryTray === true
    })
  })
  void load()
})

onBeforeUnmount(() => {
  offViewActivated?.()
  offChanged?.()
})
</script>

<template>
  <SettingsGroup title="关闭与托盘" :loading="loading" :error="error">
    <SettingsRow label="关闭主窗口时" :hint="runsInTray ? trayHint : undefined">
      <select v-model="closeAction" class="mics-select" :disabled="saving" @change="save">
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <template #actions>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="saving || savedAction === DEFAULT_CLOSE_ACTION"
          @click="reset"
        >
          重置
        </button>
      </template>
    </SettingsRow>

    <SettingsRow
      label="低内存托盘模式"
      hint="最小化到托盘时销毁主窗口以释放界面内存；恢复时重新加载，未提交的表单状态不会保留。"
    >
      <ToggleSwitch
        :model-value="lowMemoryTray"
        :disabled="saving"
        label="低内存托盘模式"
        title="开启后最小化到托盘会销毁主窗口"
        @update:model-value="setLowMemory"
      />
    </SettingsRow>
  </SettingsGroup>
</template>
