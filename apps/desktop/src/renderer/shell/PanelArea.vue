<script setup lang="ts">
import { computed } from 'vue'
import { store, viewById, viewsOf } from '../runtime/store'
import ViewHost from './ViewHost.vue'

const views = computed(() => viewsOf('panel'))
const active = computed(() => viewById(store.activePanelView))
</script>

<template>
  <section class="mics-panel">
    <div class="mics-tabs">
      <button
        v-for="view in views"
        :key="view.id"
        class="mics-tab"
        :class="{ 'is-active': store.activePanelView === view.id }"
        @click="store.activePanelView = view.id"
      >
        {{ view.title }}
      </button>
      <div class="mics-tabs__spacer" />
      <button class="mics-tab mics-tab--action" title="关闭面板" @click="store.panelVisible = false">
        ×
      </button>
    </div>
    <div class="mics-panel__body">
      <ViewHost v-if="active" :key="active.id" :view="active" />
      <div v-else class="mics-empty">没有面板视图</div>
    </div>
  </section>
</template>
