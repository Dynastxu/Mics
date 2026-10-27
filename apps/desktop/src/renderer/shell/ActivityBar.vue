<script setup lang="ts">
import { computed } from 'vue'
import { store, viewsOf } from '../runtime/store'

const views = computed(() => viewsOf('sidebar'))

function select(id: string): void {
  store.activeSidebarView = id
  store.sidebarVisible = true
}
</script>

<template>
  <nav class="mics-activity">
    <button
      v-for="view in views"
      :key="view.id"
      class="mics-activity__item"
      :class="{ 'is-active': store.activeSidebarView === view.id }"
      :title="view.title"
      @click="select(view.id)"
    >
      <span class="mics-activity__icon">{{ view.icon ?? '•' }}</span>
    </button>
  </nav>
</template>
