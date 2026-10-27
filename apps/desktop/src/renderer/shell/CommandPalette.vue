<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getContext } from '../runtime/context'
import { store } from '../runtime/store'

const query = ref('')
const index = ref(0)
const input = ref<HTMLInputElement | null>(null)

const items = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return store.commands
    .filter((item) => {
      if (!keyword) return true
      return `${item.category ?? ''} ${item.title} ${item.id}`.toLowerCase().includes(keyword)
    })
    .slice(0, 60)
})

function move(step: number): void {
  const total = items.value.length
  if (!total) return
  index.value = (index.value + step + total) % total
}

async function run(id: string): Promise<void> {
  store.paletteOpen = false
  try {
    await getContext().commands.execute(id)
  } catch (error) {
    console.error('[mics] 命令执行失败', error)
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = items.value[index.value]
    if (item) void run(item.id)
  } else if (event.key === 'Escape') {
    store.paletteOpen = false
  }
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="mics-palette" @click.self="store.paletteOpen = false">
    <div class="mics-palette__box">
      <input
        ref="input"
        v-model="query"
        class="mics-palette__input"
        placeholder="输入命令名称…（Esc 关闭）"
        @keydown="onKey"
      />
      <ul class="mics-palette__list">
        <li
          v-for="(item, i) in items"
          :key="item.id"
          class="mics-palette__item"
          :class="{ 'is-active': i === index }"
          @mouseenter="index = i"
          @click="run(item.id)"
        >
          <span class="mics-palette__title">{{ item.title }}</span>
          <span class="mics-palette__meta">
            <span v-if="item.category" class="mics-palette__category">{{ item.category }}</span>
            <span class="mics-palette__id">{{ item.id }}</span>
          </span>
        </li>
        <li v-if="!items.length" class="mics-palette__empty">没有匹配的命令</li>
      </ul>
    </div>
  </div>
</template>
