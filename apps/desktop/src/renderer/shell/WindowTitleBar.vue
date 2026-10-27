<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store } from '../runtime/store'

/**
 * 自绘标题栏（BrowserWindow 是 frame: false 的）。
 *
 * 拖动与双击最大化由 `-webkit-app-region: drag` 交给系统处理；
 * 三个窗口按钮经由 preload 的 windowControls 让主进程操作窗口。
 * 属于壳层：插件不参与窗口装饰。
 */
const maximized = ref(false)
const productName = computed(() => store.app?.name ?? 'Mics')

let dispose: (() => void) | undefined

onMounted(() => {
  const controls = window.mics.windowControls
  void controls
    .getState()
    .then((state) => {
      maximized.value = state.maximized
    })
    .catch(() => {})
  dispose = controls.onStateChange((state) => {
    maximized.value = state.maximized
  })
})

onBeforeUnmount(() => dispose?.())

function minimize(): void {
  window.mics.windowControls.minimize()
}

function toggleMaximize(): void {
  window.mics.windowControls.toggleMaximize()
}

function close(): void {
  window.mics.windowControls.close()
}
</script>

<template>
  <header class="mics-titlebar">
    <div class="mics-titlebar__brand">
      <span class="mics-titlebar__logo">M</span>
      <span class="mics-titlebar__name">{{ productName }}</span>
    </div>

    <div class="mics-titlebar__controls">
      <button class="mics-titlebar__button" title="最小化" aria-label="最小化" @click="minimize">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12h16" />
        </svg>
      </button>
      <button
        class="mics-titlebar__button"
        :title="maximized ? '还原' : '最大化'"
        :aria-label="maximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <svg v-if="maximized" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="13" height="13" rx="1.6" />
          <path d="M4 16.5v-11A1.5 1.5 0 0 1 5.5 4h11" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4.5" y="4.5" width="15" height="15" rx="1.6" />
        </svg>
      </button>
      <button
        class="mics-titlebar__button mics-titlebar__button--close"
        title="关闭"
        aria-label="关闭"
        @click="close"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5.5 5.5 13 13" />
          <path d="m18.5 5.5-13 13" />
        </svg>
      </button>
    </div>
  </header>
</template>
