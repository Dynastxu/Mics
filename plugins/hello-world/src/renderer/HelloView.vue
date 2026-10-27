<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'

interface GreetResult {
  message: string
  count: number
}

const ctx = usePluginContext()
const target = ref('Mics')
const message = ref('点击按钮调用主进程插件方法')
const count = ref(0)
const events = ref<string[]>([])
let off: (() => void) | undefined

async function greet(): Promise<void> {
  try {
    const result = await ctx.ipc.invoke<GreetResult>('mics.hello-world', 'greet', {
      target: target.value,
    })
    message.value = result.message
    count.value = result.count
  } catch (error) {
    message.value = `调用失败：${error instanceof Error ? error.message : String(error)}`
  }
}

async function reset(): Promise<void> {
  await ctx.commands.execute('hello.reset')
  count.value = 0
  message.value = '计数已重置'
}

onMounted(() => {
  off = ctx.ipc.on('hello/greeted', (payload) => {
    events.value = [JSON.stringify(payload), ...events.value].slice(0, 5)
  })
})

onBeforeUnmount(() => off?.())
</script>

<template>
  <div class="hello">
    <header class="hello__header">
      <h2>Hello World</h2>
      <p>主进程插件提供 RPC 与命令，这个视图由渲染进程插件注册。</p>
    </header>

    <div class="hello__row">
      <label class="hello__label" for="hello-target">称呼</label>
      <input id="hello-target" v-model="target" class="hello__input" placeholder="世界" />
      <button class="hello__button" @click="greet">调用 greet</button>
      <button class="hello__button hello__button--ghost" @click="reset">重置计数</button>
    </div>

    <div class="hello__result">
      <strong>{{ message }}</strong>
      <span class="hello__count">累计调用 {{ count }} 次</span>
    </div>

    <section class="hello__events">
      <h3>事件流（ctx.ipc.on）</h3>
      <ul v-if="events.length">
        <li v-for="(event, index) in events" :key="index">
          <code>{{ event }}</code>
        </li>
      </ul>
      <p v-else class="hello__hint">还没有事件；触发 greet 后会收到 hello/greeted。</p>
    </section>
  </div>
</template>

<style scoped>
.hello {
  max-width: 720px;
}

.hello__header h2 {
  margin: 0 0 6px;
  font-size: 20px;
}

.hello__header p {
  margin: 0 0 20px;
  color: var(--mics-fg-muted);
  line-height: 1.7;
}

.hello__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.hello__label {
  color: var(--mics-fg-muted);
}

.hello__input {
  flex: 0 1 220px;
  padding: 8px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg);
  font: inherit;
  outline: none;
}

.hello__input:focus {
  border-color: var(--mics-accent);
}

.hello__button {
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--mics-accent);
  color: var(--mics-accent-fg);
  font-weight: 600;
}

.hello__button:hover {
  filter: brightness(1.08);
}

.hello__button--ghost {
  background: transparent;
  border: 1px solid var(--mics-border);
  color: var(--mics-fg);
}

.hello__result {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--mics-border);
  border-radius: 10px;
  background: var(--mics-bg-elevated);
}

.hello__count {
  color: var(--mics-fg-muted);
  font-size: 12px;
}

.hello__events {
  margin-top: 24px;
}

.hello__events h3 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--mics-fg-muted);
  font-weight: 600;
}

.hello__events ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.hello__events li {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--mics-bg-elevated);
  border: 1px solid var(--mics-border);
  overflow: auto;
}

.hello__events code {
  font-size: 11px;
  color: var(--mics-fg-muted);
}

.hello__hint {
  margin: 0;
  color: var(--mics-fg-muted);
  font-size: 12px;
}
</style>
