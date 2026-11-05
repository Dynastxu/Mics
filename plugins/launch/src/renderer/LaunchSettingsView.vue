<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext, useSettingsExtensions } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsPage, SettingsRow } from '@mics/ui'
import type { LaunchSettings, RepeatLaunchBehavior } from '../shared'

const ctx = usePluginContext()
const memory = ref('4096')
const javaPath = ref('')
const width = ref('1280')
const height = ref('720')
const jvmArgs = ref('')
const repeatBehavior = ref<RepeatLaunchBehavior>('prompt')
const error = ref('')

const extensions = useSettingsExtensions('settings.launch')

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function load(): Promise<void> {
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get')
    repeatBehavior.value = settings.repeatBehavior
    memory.value = String(settings.maxMemory)
  } catch {
    /* 使用默认的「提示」与 4096 MB */
  }
}

async function saveBehavior(): Promise<void> {
  error.value = ''
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', {
      repeatBehavior: repeatBehavior.value
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
      maxMemory: Number(memory.value)
    })
    memory.value = String(settings.maxMemory)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

onMounted(load)
</script>

<template>
  <SettingsPage title="启动设置" :error="error" :extensions="extensions">
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

      <SettingsRow label="最大内存" hint="单位 MB，范围 1024–32768" html-for="launch-memory">
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

    <SettingsGroup title="Java 与窗口">
      <SettingsRow label="Java 路径" hint="留空时按游戏版本自动选择" html-for="launch-java">
        <input id="launch-java" v-model="javaPath" class="mics-input" placeholder="自动检测" />
      </SettingsRow>

      <SettingsRow label="游戏窗口">
        <input v-model="width" class="mics-input" inputmode="numeric" aria-label="窗口宽度" />
        <span class="mics-muted">×</span>
        <input v-model="height" class="mics-input" inputmode="numeric" aria-label="窗口高度" />
      </SettingsRow>

      <SettingsRow label="JVM 参数" html-for="launch-jvm-args">
        <input
          id="launch-jvm-args"
          v-model="jvmArgs"
          class="mics-input"
          placeholder="-XX:+UseG1GC"
        />
      </SettingsRow>
    </SettingsGroup>

    <template #footer>
      <p class="mics-page__note">Java 路径、窗口尺寸与 JVM 参数尚未接入启动参数。</p>
    </template>
  </SettingsPage>
</template>
