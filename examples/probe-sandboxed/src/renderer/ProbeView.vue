<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import { pluginIdOf } from '@mics/sdk'

interface ProbeResult {
  ok: boolean
  detail: string
}

interface LogEntry extends ProbeResult {
  op: string
}

const ctx = usePluginContext()
const selfId = pluginIdOf(ctx)

const log = ref<LogEntry[]>([])
const info = ref('')
const busy = ref(false)

async function invoke<T>(method: string, params?: unknown): Promise<T> {
  if (!selfId) throw new Error('[mics] 探针缺少插件 id')
  return ctx.ipc.invoke<T>(selfId, method, params)
}

async function run(op: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await invoke<ProbeResult>('probe/run', { op })
    if (op === 'info') info.value = result.detail
    else log.value = [{ op, ...result }, ...log.value].slice(0, 20)
  } catch (error) {
    log.value = [
      { op, ok: false, detail: error instanceof Error ? error.message : String(error) },
      ...log.value
    ].slice(0, 20)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void run('info')
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">隔离探针 · sandboxed</h1>
      <p class="mics-page__subtitle">
        只允许读写 <code>${userData}/probe-sandbox</code>。「写白名单外 / 读系统文件 /
        起子进程」在 enforce 模式下应被引擎拒绝；audit 模式下会成功。
      </p>
    </header>

    <section class="probe">
      <pre class="probe__info">{{ info }}</pre>

      <div class="probe__actions">
        <button class="mics-button" :disabled="busy" @click="run('write-allowed')">
          写允许目录
        </button>
        <button class="mics-button" :disabled="busy" @click="run('write-outside')">
          写白名单外
        </button>
        <button class="mics-button" :disabled="busy" @click="run('read-system')">
          读系统文件
        </button>
        <button class="mics-button" :disabled="busy" @click="run('spawn')">起子进程</button>
      </div>

      <ul class="probe__log">
        <li v-for="(entry, index) in log" :key="index" :class="{ 'is-bad': !entry.ok }">
          <span class="probe__tag">{{ entry.op }}</span>
          <span class="probe__result">{{ entry.ok ? '成功' : '被拒绝' }}</span>
          <span class="probe__detail">{{ entry.detail }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.probe {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.probe__info {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.probe__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.probe__log {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.probe__log li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 8px 10px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  font-size: 12px;
}

.probe__tag {
  flex: 0 0 108px;
  color: var(--mics-fg-muted);
}

.probe__result {
  flex: 0 0 48px;
  color: var(--mics-accent);
}

.probe__log li.is-bad .probe__result {
  color: var(--mics-danger, #f06a6a);
}

.probe__detail {
  flex: 1;
  overflow-wrap: anywhere;
  color: var(--mics-fg-muted);
}
</style>
