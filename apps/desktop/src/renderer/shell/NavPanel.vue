<script setup lang="ts">
import { computed } from 'vue'
import {
  isGroupExpanded,
  navRoots,
  store,
  toggleGroup,
  type NavGroup,
  type NavItem,
} from '../runtime/store'
import MicsIcon from './MicsIcon.vue'

const roots = computed(() => navRoots())
const width = computed(() => `${store.layout?.regions?.nav?.width ?? 232}px`)

function select(item: NavItem): void {
  store.activeView = item.id
}

function isGroupCurrent(group: NavGroup): boolean {
  return group.items.some((item) => item.id === store.activeView)
}
</script>

<template>
  <aside class="mics-nav" :style="{ width }">
    <nav class="mics-nav__list">
      <template v-for="root in roots" :key="root.kind === 'item' ? root.item.id : root.group.id">
        <button
          v-if="root.kind === 'item'"
          class="mics-nav__item"
          :class="{ 'is-active': store.activeView === root.item.id }"
          @click="select(root.item)"
        >
          <MicsIcon :name="root.item.icon" />
          <span class="mics-nav__label">{{ root.item.title }}</span>
        </button>

        <div v-else class="mics-nav__group">
          <button
            class="mics-nav__item mics-nav__group-header"
            :class="{
              'is-current': isGroupCurrent(root.group),
            }"
            @click="toggleGroup(root.group.id)"
          >
            <MicsIcon :name="root.group.icon" />
            <span class="mics-nav__label">{{ root.group.title }}</span>
            <MicsIcon
              class="mics-nav__chevron"
              :class="{ 'is-open': isGroupExpanded(root.group.id) }"
              name="chevron"
              :size="14"
            />
          </button>

          <div v-show="isGroupExpanded(root.group.id)" class="mics-nav__children">
            <button
              v-for="item in root.group.items"
              :key="item.id"
              class="mics-nav__item mics-nav__item--child"
              :class="{ 'is-active': store.activeView === item.id }"
              @click="select(item)"
            >
              <MicsIcon :name="item.icon" :size="15" />
              <span class="mics-nav__label">{{ item.title }}</span>
            </button>
          </div>
        </div>
      </template>
    </nav>
  </aside>
</template>
