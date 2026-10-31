<script setup lang="ts">
import { ref } from 'vue'
import type { CatalogItem } from './catalog'
import { formatDownloads } from './catalog'

const props = withDefaults(
  defineProps<{
    item: CatalogItem
    /** 是否显示类型标签（整合包 / Mod 都可关掉） */
    showTags?: boolean
  }>(),
  { showTags: true },
)

const emit = defineEmits<{ open: [] }>()

const iconFailed = ref(false)
</script>

<template>
  <article
    class="mics-card catalog-card"
    role="button"
    tabindex="0"
    :aria-label="`查看 ${item.name}`"
    @click="emit('open')"
    @keydown.enter="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <div class="catalog-card__head">
      <img
        v-if="item.icon && !iconFailed"
        class="catalog-card__icon"
        :src="item.icon"
        :alt="item.name"
        loading="lazy"
        @error="iconFailed = true"
      />
      <span v-else class="catalog-card__icon catalog-card__icon--fallback">
        {{ item.name.slice(0, 1).toUpperCase() }}
      </span>

      <div class="catalog-card__title-block">
        <span class="mics-card__title">{{ item.name }}</span>
        <span class="mics-card__meta">{{ item.author || '未知作者' }}</span>
      </div>

      <span class="mics-badge">{{ item.sourceLabel }}</span>
    </div>

    <p class="mics-card__text">{{ item.summary }}</p>

    <div v-if="showTags && item.categories.length" class="catalog-card__tags">
      <span v-for="label in item.categories.slice(0, 3)" :key="label" class="catalog-card__tag">
        {{ label }}
      </span>
    </div>

    <div class="mics-card__foot">
      <span class="mics-card__meta">下载 {{ formatDownloads(item.downloads) }}</span>
    </div>
  </article>
</template>

<style scoped>
.catalog-card {
  cursor: pointer;
  text-align: left;
}

.catalog-card:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.catalog-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.catalog-card__icon,
.catalog-card__icon--fallback {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  object-fit: cover;
}

.catalog-card__icon--fallback {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #4c8dff, #7c5cff);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}

.catalog-card__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.catalog-card__title-block .mics-card__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.catalog-card__tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}
</style>
