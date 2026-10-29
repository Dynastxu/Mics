<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { pluginIdOf } from '@mics/sdk'

/**
 * 插件版本号：改这里的常量并点「重载」，页面上的数字应该立刻变，
 * 而应用主进程 PID 不变——这是热重载的验收点之一。
 */
const VERSION = '0.1.0'

interface NoteResult {
  path: string
  text: string
}

const ctx = usePluginContext()
const selfId = pluginIdOf(ctx)

const version = ref('')
const notePath = ref('')
const noteText = ref('')
const draft = ref('hello from the renderer')
const error = ref('')
const busy = ref(false)

async function invoke<T>(method: string, params?: unknown): Promise<T> {
  if (!selfId) throw new Error('[mics] 示例插件缺少插件 id')
  return ctx.ipc.invoke<T>(selfId, method, params)
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function write(): Promise<void> {
  return run(async () => {
    const result = await invoke<NoteResult>('file/write', { text: draft.value })
    notePath.value = result.path
    noteText.value = result.text
  })
}

function read(): Promise<void> {
  return run(async () => {
    const result = await invoke<NoteResult>('file/read')
    notePath.value = result.path
    noteText.value = result.text
  })
}

onMounted(() => {
  void run(async () => {
    version.value = await invoke<string>('hello/version')
  })
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">示例插件</h1>
      <span class="mics-badge">页面 v{{ VERSION }} · 后台 v{{ version || '—' }}</span>
    </header>

    <p v-if="error" class="hello__error">{{ error }}</p>

    <section class="mics-section">
      <h2 class="mics-section__title">主进程文件读写</h2>
      <div class="hello__row">
        <input
          v-model="draft"
          class="mics-input hello__input"
          placeholder="写入 note.txt 的内容"
          :disabled="busy"
        />
        <button class="mics-button mics-button--primary" :disabled="busy" @click="write">
          写入
        </button>
        <button class="mics-button mics-button--ghost" :disabled="busy" @click="read">读取</button>
      </div>
      <p v-if="notePath" class="mics-page__note">{{ notePath }}</p>
      <pre v-if="noteText" class="hello__note">{{ noteText }}</pre>
    </section>
  </div>
</template>

<style scoped>
.hello__row {
  display: flex;
  gap: 8px;
}

.hello__input {
  flex: 1;
  min-width: 0;
}

.hello__note {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}

.hello__error {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}
</style>
