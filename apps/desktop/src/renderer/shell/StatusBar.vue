<script setup lang="ts">
import { computed } from 'vue'
import { getContext } from '../runtime/context'
import { statusBarItems, store } from '../runtime/store'

const items = computed(() => statusBarItems())
const left = computed(() => items.value.filter((item) => (item.alignment ?? 'left') === 'left'))
const right = computed(() => items.value.filter((item) => item.alignment === 'right'))
const activeCount = computed(() => store.plugins.filter((plugin) => plugin.state === 'active').length)

function run(command?: string): void {
  if (!command) return
  void getContext().commands.execute(command).catch(() => {})
}

function changeTheme(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  getContext().theme.apply(value)
}
</script>

<template>
  <footer class="mics-status">
    <div class="mics-status__group">
      <span class="mics-status__item mics-status__item--static">
        {{ store.app?.name ?? 'Mics' }} {{ store.app?.version ?? '' }}
      </span>
      <button
        v-for="item in left"
        :key="`${item.pluginId ?? 'mics'}:${item.id}`"
        class="mics-status__item"
        :title="item.tooltip ?? item.text"
        @click="run(item.command)"
      >
        {{ item.text }}
      </button>
    </div>
    <div class="mics-status__group">
      <button
        v-for="item in right"
        :key="`${item.pluginId ?? 'mics'}:${item.id}`"
        class="mics-status__item"
        :title="item.tooltip ?? item.text"
        @click="run(item.command)"
      >
        {{ item.text }}
      </button>
      <select class="mics-status__select" :value="store.themeId" @change="changeTheme">
        <option v-for="theme in store.themes" :key="theme.id" :value="theme.id">
          {{ theme.label }}
        </option>
      </select>
      <span class="mics-status__item mics-status__item--static">
        插件 {{ activeCount }}/{{ store.plugins.length }}
      </span>
      <button class="mics-status__item" @click="store.paletteOpen = true">命令</button>
    </div>
  </footer>
</template>
