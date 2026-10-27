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
const isolation = ref('instance')
const repeatBehavior = ref<RepeatLaunchBehavior>('prompt')

async function load(): Promise<void> {
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/get')
    repeatBehavior.value = settings.repeatBehavior
  } catch { /* 使用默认的「提示」 */ }
}

async function saveBehavior(): Promise<void> {
  try {
    const settings = await ctx.ipc.invoke<LaunchSettings>('mics.launch', 'settings/set', {
      repeatBehavior: repeatBehavior.value,
    })
    repeatBehavior.value = settings.repeatBehavior
  } catch { /* 保存失败时保留当前选择 */ }
}

onMounted(load)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">启动设置</h1>
    </header>

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
          <div class="mics-field__hint">单位 MB，留空由启动器自动分配</div>
        </div>
        <div class="mics-field__control">
          <input v-model="memory" class="mics-input" inputmode="numeric" placeholder="4096" />
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

      <div class="mics-field">
        <div class="mics-field__label">版本隔离</div>
        <div class="mics-field__control">
          <select v-model="isolation" class="mics-select">
            <option value="instance">按实例隔离</option>
            <option value="shared">共享 .minecraft</option>
          </select>
        </div>
      </div>
    </div>

    <p class="mics-page__note">内存、Java 路径等设置尚未接入启动参数。</p>
  </div>
</template>
