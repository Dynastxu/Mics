<script setup lang="ts">
import { computed } from 'vue'
import type { ListRow, ListRowRole } from './types'

const props = withDefaults(
  defineProps<{
    items: ListRow[]
    /** button = 整行可点击进入；radio = 单选列表并显示勾；checkbox = 多选列表 */
    role?: ListRowRole
    /** radio 模式下当前选中的行 */
    selectedId?: string
    /** checkbox 模式下当前选中的行 */
    selectedIds?: string[]
    /** button 模式下 aria-label / title 的前缀，例如「安装」 */
    actionLabel?: string
    emptyText?: string
    /** 主文本是否使用等宽字体（版本号这类用 true，名称类关掉） */
    mono?: boolean
  }>(),
  {
    role: 'button',
    selectedId: '',
    selectedIds: () => [],
    actionLabel: '',
    emptyText: '没有匹配的数据',
    mono: true,
  },
)

const emit = defineEmits<{ select: [id: string] }>()

const hasAnyImg = computed(() => props.items.some((item) => item.img))

function isSelected(id: string): boolean {
  if (props.role === 'checkbox') return props.selectedIds.includes(id)
  return props.selectedId === id
}

function actionText(item: ListRow): string {
  return props.actionLabel ? `${props.actionLabel} ${item.label}` : item.label
}
</script>

<template>
  <div v-if="items.length" class="mics-list">
    <div
      v-for="(item, index) in items"
      :key="item.id"
      class="mics-list__row"
      :class="{ 'is-selected': role !== 'button' && isSelected(item.id) }"
      :role="role"
      :tabindex="0"
      :aria-checked="role === 'radio' ? isSelected(item.id) : role === 'checkbox' ? isSelected(item.id) : undefined"
      :aria-label="role === 'button' ? actionText(item) : undefined"
      :title="role === 'button' ? actionText(item) : undefined"
      @click="emit('select', item.id)"
      @keydown.enter.prevent="emit('select', item.id)"
      @keydown.space.prevent="emit('select', item.id)"
    >
      <slot name="row" :item="item" :index="index">
        <!-- 左侧：自定义插槽 > 图片/占位（保证行间对齐） -->
        <slot name="left" :item="item" :index="index">
          <template v-if="hasAnyImg">
            <img
              v-if="item.img"
              :src="item.img"
              :alt="item.imgAlt ?? ''"
              class="mics-list__img"
            />
            <span v-else class="mics-list__img mics-list__img--ghost" />
          </template>
        </slot>

        <div class="mics-list__main">
          <div class="mics-list__title">
            <span :class="{ 'mics-mono': mono }">{{ item.label }}</span>
            <template v-if="item.badges">
              <span
                v-for="b in item.badges"
                :key="b.label"
                class="mics-badge"
                :class="{ 'mics-badge--accent': b.accent }"
              >
                {{ b.label }}
              </span>
            </template>
            <span
              v-else-if="item.badge"
              class="mics-badge"
              :class="{ 'mics-badge--accent': item.badgeAccent }"
            >
              {{ item.badge }}
            </span>
          </div>
          <div v-if="item.meta" class="mics-list__meta">{{ item.meta }}</div>
        </div>

        <!-- 右侧：自定义插槽 > radio 勾号 -->
        <slot name="actions" :item="item" :index="index">
          <svg
            v-if="role === 'radio' && isSelected(item.id)"
            class="mics-check"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m20 6-11 11-5-5" />
          </svg>
        </slot>
      </slot>
    </div>
  </div>
  <div v-else class="mics-empty">
    <slot name="empty">{{ emptyText }}</slot>
  </div>
</template>

<style scoped>
.mics-list__row.is-selected {
  box-shadow: inset 3px 0 0 var(--mics-accent);
}

.mics-list__img {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  object-fit: cover;
}

.mics-list__img--ghost {
  visibility: hidden;
}

.mics-check {
  flex: none;
  color: var(--mics-accent);
}
</style>