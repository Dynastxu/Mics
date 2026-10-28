<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import DataList from './DataList.vue'
import FilterButton from './FilterButton.vue'
import FilterPanel from './FilterPanel.vue'
import { defaultSelection, filterRows, isFilterActive } from './list'
import type { FilterGroup, FilterSelection, ListRow, ListRowRole } from './types'

const props = withDefaults(
  defineProps<{
    /** 数据源；筛选与排序都由组件内部完成 */
    items: ListRow[]
    /** 筛选分组；不传时整块筛选 UI 不渲染 */
    groups?: FilterGroup[]
    /** 分区标题，默认渲染成「标题 · 数量」；需要别的排版时用 #heading */
    title?: string
    /** 是否显示搜索框 */
    searchable?: boolean
    searchPlaceholder?: string
    /** 搜索框的 aria-label，默认取 placeholder */
    searchLabel?: string
    /** 覆盖默认搜索字段（默认 label / badge / meta / keywords / tags） */
    searchText?: (row: ListRow) => string
    /** 覆盖默认的 tags 匹配，用于区间、包含等复杂规则 */
    match?: (row: ListRow, selection: FilterSelection) => boolean
    /** 过滤后排序；selection 让「排序方式」分组可用 */
    sort?: (a: ListRow, b: ListRow, selection: FilterSelection) => number
    /** 行语义：button = 整行点击进入；radio = 单选列表；checkbox = 多选列表；static = 纯展示 */
    role?: ListRowRole
    /** radio 模式下当前选中的行 */
    selectedId?: string
    /** checkbox 模式下当前选中的行 */
    selectedIds?: string[]
    /** button 模式下 aria-label / title 的前缀 */
    actionLabel?: string
    emptyText?: string
    filterLabel?: string
    /** 主文本是否使用等宽字体 */
    mono?: boolean
    /** 可选的受控搜索词：需要跨页面保留时传 v-model:query */
    query?: string
    /** 可选的受控筛选：需要跨页面保留时传 v-model:filter */
    filter?: FilterSelection
  }>(),
  {
    groups: () => [],
    title: '',
    searchable: true,
    searchPlaceholder: '搜索',
    searchLabel: '',
    role: 'button',
    selectedId: '',
    actionLabel: '',
    emptyText: '没有匹配的数据',
    filterLabel: '筛选',
    mono: true,
  },
)

const emit = defineEmits<{
  select: [id: string]
  'update:query': [value: string]
  'update:filter': [value: FilterSelection]
}>()

const panelId = useId()
const panelOpen = ref(false)

/** 受控时跟随外部值，否则自己保存 */
const localQuery = ref(props.query ?? '')
const localFilter = ref<FilterSelection>(props.filter ?? defaultSelection(props.groups))

watch(
  () => props.query,
  (value) => {
    if (value !== undefined) localQuery.value = value
  },
)

watch(
  () => props.filter,
  (value) => {
    if (value !== undefined) localFilter.value = value
  },
)

const selected = computed<FilterSelection>({
  get: () => localFilter.value,
  set: (value) => {
    localFilter.value = value
    emit('update:filter', value)
  },
})

const rows = computed(() =>
  filterRows(props.items, {
    groups: props.groups,
    selection: localFilter.value,
    query: localQuery.value,
    searchText: props.searchText,
    match: props.match,
    sort: props.sort,
  }),
)

const count = computed(() => rows.value.length)
const filterActive = computed(() => isFilterActive(localFilter.value, props.groups))

function onQueryInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  localQuery.value = value
  emit('update:query', value)
}
</script>

<template>
  <div v-if="searchable || groups.length" class="mics-toolbar">
    <input
      v-if="searchable"
      class="mics-input mics-toolbar__grow"
      type="text"
      :value="localQuery"
      :placeholder="searchPlaceholder"
      :aria-label="searchLabel || searchPlaceholder"
      spellcheck="false"
      @input="onQueryInput"
    />
    <FilterButton
      v-if="groups.length"
      v-model:open="panelOpen"
      :active="filterActive"
      :label="filterLabel"
      :aria-controls="panelId"
    />
  </div>

  <FilterPanel v-if="panelOpen && groups.length" :id="panelId" v-model="selected" :groups="groups" />

  <section class="mics-section">
    <slot name="heading" :count="count">
      <h2 v-if="title" class="mics-section__title">{{ title }} · {{ count }}</h2>
    </slot>

    <DataList
      :items="rows"
      :role="role"
      :selected-id="selectedId"
      :selected-ids="selectedIds"
      :action-label="actionLabel"
      :empty-text="emptyText"
      :mono="mono"
      @select="emit('select', $event)"
    >
      <template v-if="$slots.row" #row="slotProps">
        <slot name="row" v-bind="slotProps" />
      </template>
      <template v-if="$slots.left" #left="slotProps">
        <slot name="left" v-bind="slotProps" />
      </template>
      <template v-if="$slots.actions" #actions="slotProps">
        <slot name="actions" v-bind="slotProps" />
      </template>
      <template v-if="$slots.empty" #empty>
        <slot name="empty" />
      </template>
    </DataList>
  </section>
</template>