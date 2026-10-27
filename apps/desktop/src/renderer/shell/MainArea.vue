<script setup lang="ts">
import { computed } from 'vue'
import { navItemById, store } from '../runtime/store'
import PageHost from './PageHost.vue'

const page = computed(() => navItemById(store.activeView))
</script>

<template>
  <main class="mics-main">
    <div class="mics-main__body">
      <PageHost v-if="page" :key="page.id" :page="page" />
      <div v-else class="mics-empty">左侧还没有可用的页面</div>
    </div>
  </main>
</template>
