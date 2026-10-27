<script setup lang="ts">
import { computed } from 'vue'
import { store, viewById } from '../runtime/store'
import ViewHost from './ViewHost.vue'

const view = computed(() => viewById(store.activeSidebarView))
const width = computed(() => `${store.layout?.regions?.sidebar?.width ?? 280}px`)
</script>

<template>
  <aside class="mics-sidebar" :style="{ width }">
    <header class="mics-sidebar__header">{{ view?.title ?? '侧边栏' }}</header>
    <div class="mics-sidebar__body">
      <ViewHost v-if="view" :key="view.id" :view="view" />
      <div v-else class="mics-empty">没有可用的侧边栏视图</div>
    </div>
  </aside>
</template>
