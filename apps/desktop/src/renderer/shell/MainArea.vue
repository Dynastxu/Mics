<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { navItemById, store, type NavItem } from '../runtime/store'
import PageHost from './PageHost.vue'

const page = computed(() => navItemById(store.activeView))

/**
 * 访问过的页面保持挂载：切换导航只切换可见性，不销毁页面组件。
 *
 * 页面里的搜索词、筛选、详情选择、未提交的表单和各自的滚动位置都跟着组件保留；
 * 插件被禁用 / 卸载时页面从栈中移除，重新启用后才会重新挂载。
 */
const visited = ref<string[]>([])

const pages = computed<NavItem[]>(() =>
  visited.value
    .map((id) => navItemById(id))
    .filter((item): item is NavItem => item !== undefined),
)

watch(
  () => page.value?.id,
  (id) => {
    if (!id || visited.value.includes(id)) return
    visited.value = [...visited.value, id]
  },
  { immediate: true },
)

// 插件消失后导航项也消失：对应页面必须一起卸载，否则会留下失效组件与陈旧作用域
watch(
  () => store.nav,
  () => {
    const alive = new Set(store.nav.map((item) => item.id))
    if (visited.value.every((id) => alive.has(id))) return
    visited.value = visited.value.filter((id) => alive.has(id))
  },
)
</script>

<template>
  <main class="mics-main">
    <div class="mics-main__body">
      <div
        v-for="item in pages"
        :key="item.id"
        class="mics-main__page"
        :class="{ 'is-active': item.id === store.activeView }"
        :aria-hidden="item.id !== store.activeView"
        :inert="item.id !== store.activeView"
      >
        <PageHost :page="item" />
      </div>
      <div v-if="!page" class="mics-main__page is-active">
        <div class="mics-empty">左侧还没有可用的页面</div>
      </div>
    </div>
  </main>
</template>
