<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Context } from 'cordis'
import { ToggleSwitch } from '@mics/ui'
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
 * 注册方传入自己的插件 Context。
 *
 * 这个组件渲染在 `mics.settings` 的通用页里，`usePluginContext()` 会拿到
 * mics.settings 的上下文；RPC 与事件必须用 close-behavior 自己的 ctx，
 * 否则 callerId 与监听器归属都会错。
 */
const props = defineProps<{ ctx: Context }>()

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
    apply(await props.ctx.ipc.invoke<CloseSettings>('mics.close-behavior', 'settings/get'))
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
      await props.ctx.ipc.invoke<CloseSettings>('mics.close-behavior', 'settings/set', {
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
  offViewActivated = props.ctx.on('ui/viewActivated', (viewId: string) => {
    if (viewId === 'settings.general') void load()
  })
  offChanged = props.ctx.ipc.on(CLOSE_BEHAVIOR_CHANGED, (payload) => {
    if (saving.value) return
    const settings = payload as Partial<CloseSettings> | undefined
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
  <div class="close-behavior-section">
    <p v-if="error" class="close-behavior__error">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取设置…</div>

    <div v-else class="mics-form">
      <div class="mics-field">
        <div>
          <div class="mics-field__label">关闭主窗口时</div>
          <div v-if="runsInTray" class="mics-field__hint">{{ trayHint }}</div>
        </div>
        <div class="mics-field__control">
          <select v-model="closeAction" class="mics-select" :disabled="saving" @change="save">
            <option v-for="option in options" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <button
            class="mics-button mics-button--ghost mics-button--small"
            :disabled="saving || savedAction === DEFAULT_CLOSE_ACTION"
            @click="reset"
          >
            重置
          </button>
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">低内存托盘模式</div>
          <div class="mics-field__hint">
            最小化到托盘时销毁主窗口以释放界面内存；恢复时重新加载，未提交的表单状态不会保留。
          </div>
        </div>
        <div class="mics-field__control">
          <ToggleSwitch
            :model-value="lowMemoryTray"
            :disabled="saving"
            label="低内存托盘模式"
            title="开启后最小化到托盘会销毁主窗口"
            @update:model-value="setLowMemory"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.close-behavior__error {
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}
</style>
