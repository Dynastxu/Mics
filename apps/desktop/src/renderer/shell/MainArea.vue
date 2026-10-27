<script setup lang="ts">
import { computed } from 'vue'
import { store, viewById, viewsOf } from '../runtime/store'
import ViewHost from './ViewHost.vue'

const views = computed(() => viewsOf('main'))
const active = computed(() => viewById(store.activeMainView))
</script>

<template>
  <main class="mics-main">
    <div class="mics-tabs">
      <button
        v-for="view in views"
        :key="view.id"
        class="mics-tab"
        :class="{ 'is-active': store.activeMainView === view.id }"
        @click="store.activeMainView = view.id"
      >
        <span v-if="view.icon" class="mics-tab__icon">{{ view.icon }}</span>
        {{ view.title }}
      </button>
      <div class="mics-tabs__spacer" />
    </div>
    <div class="mics-main__body">
      <ViewHost v-if="active" :key="active.id" :view="active" />
      <div v-else class="mics-empty">没有主区域视图</div>
    </div>
  </main>
</template>
