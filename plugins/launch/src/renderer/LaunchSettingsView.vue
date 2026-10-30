<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { LaunchSettings, RepeatLaunchBehavior } from '../shared'

const ctx = usePluginContext()
const memory = ref('4096')
const javaPath = ref('')
const width = ref('1280')
const height = ref('720')
const jvmArgs = ref('')
const repeatBehavior = ref<RepeatLaunchBehavior>('prompt')
const error = ref('')

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function load(): Promise<void> {
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get')
    repeatBehavior.value = settings.repeatBehavior
    memory.value = String(settings.maxMemory)
  } catch { /* 使用默认的「提示」与 4096 MB */ }
}

async function saveBehavior(): Promise<void> {
  error.value = ''
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', {
      repeatBehavior: repeatBehavior.value,
    })
    repeatBehavior.value = settings.repeatBehavior
    memory.value = String(settings.maxMemory)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function saveMemory(): Promise<void> {
  error.value = ''
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', {
      maxMemory: Number(memory.value),
    })
    memory.value = String(settings.maxMemory)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

onMounted(load)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">启动设置</h1>
    </header>

    <p v-if="error" class="launch-settings__error">{{ error }}</p>

    <div class="mics-form">
      <div class="mics-field">
        <div>
          <div class="mics-field__label">重复启动行为</div>
          <div class="mics-field__hint">实例已在运行时再次点击开始游戏</div>
        </div>
        <div class="mics-field__control">
          <select v-model="repeatBehavior" class="mics-select" @change="saveBehavior">
            <option value="prompt">提示</option>
            <option value="launch">启动</option>
            <option value="ignore">忽略</option>
          </select>
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">最大内存</div>
          <div class="mics-field__hint">单位 MB，范围 1024–32768</div>
        </div>
        <div class="mics-field__control">
          <input
            v-model="memory"
            class="mics-input"
            inputmode="numeric"
            placeholder="4096"
            @change="saveMemory"
          />
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">Java 路径</div>
          <div class="mics-field__hint">留空时按游戏版本自动选择</div>
        </div>
        <div class="mics-field__control">
          <input v-model="javaPath" class="mics-input" placeholder="自动检测" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">游戏窗口</div>
        <div class="mics-field__control">
          <input v-model="width" class="mics-input" inputmode="numeric" />
          <span class="mics-muted">×</span>
          <input v-model="height" class="mics-input" inputmode="numeric" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">JVM 参数</div>
        <div class="mics-field__control">
          <input v-model="jvmArgs" class="mics-input" placeholder="-XX:+UseG1GC" />
        </div>
      </div>
    </div>

    <p class="mics-page__note">Java 路径、窗口尺寸与 JVM 参数尚未接入启动参数。</p>
  </div>
</template>

<style scoped>
.launch-settings__error {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}
</style>
