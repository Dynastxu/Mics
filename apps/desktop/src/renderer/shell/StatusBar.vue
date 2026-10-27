<script setup lang="ts">
import { computed } from 'vue'
import type { MicsWindowResizePhase } from '@mics/sdk'
import { getContext } from '../runtime/context'
import { statusBarItems, store } from '../runtime/store'

const items = computed(() => statusBarItems())
const left = computed(() => items.value.filter((item) => (item.alignment ?? 'left') === 'left'))
const right = computed(() => items.value.filter((item) => item.alignment === 'right'))
const activeCount = computed(() => store.plugins.filter((plugin) => plugin.state === 'active').length)

/** 拖动中才转发 move，避免鼠标掠过时产生无意义的 IPC */
let resizing = false

function run(command?: string): void {
  if (!command) return
  void getContext().commands.execute(command).catch(() => {})
}

function changeTheme(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  getContext().theme.apply(value)
}

function reportResize(phase: MicsWindowResizePhase, event: PointerEvent): void {
  window.mics.windowControls.resizeWindow({ phase, x: event.screenX, y: event.screenY })
}

function startResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  resizing = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  reportResize('start', event)
}

function moveResize(event: PointerEvent): void {
  if (!resizing) return
  reportResize('move', event)
}

function endResize(event: PointerEvent): void {
  if (!resizing) return
  resizing = false
  reportResize('end', event)
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
      <div
        class="mics-status__grip"
        title="拖动调整窗口大小"
        @pointerdown="startResize"
        @pointermove="moveResize"
        @pointerup="endResize"
        @pointercancel="endResize"
        @lostpointercapture="endResize"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M11 3.5 3.5 11" />
          <path d="M11 7 7 11" />
          <path d="M11 10.5 10.5 11" />
        </svg>
      </div>
    </div>
  </footer>
</template>
