<script setup lang="ts">
import type { FilterGroup, FilterSelection } from './types'

defineProps<{ groups: FilterGroup[] }>()

/** 每组选中的值；multi 组为空数组表示「全部」 */
const selection = defineModel<FilterSelection>({ required: true })

function isMulti(group: FilterGroup): boolean {
  return (group.mode ?? 'multi') === 'multi'
}

function isExclusive(group: FilterGroup, value: string): boolean {
  return Boolean(group.exclusive) && group.exclusive === value
}

function isActive(group: FilterGroup, value: string): boolean {
  const values = selection.value[group.key] ?? []
  return isExclusive(group, value) ? values.length === 0 : values.includes(value)
}

function choose(group: FilterGroup, value: string): void {
  // 「全部」在两种模式下含义相同：清空这一组
  if (isExclusive(group, value)) {
    selection.value = { ...selection.value, [group.key]: [] }
    return
  }

  if (!isMulti(group)) {
    selection.value = { ...selection.value, [group.key]: [value] }
    return
  }

  const values = (selection.value[group.key] ?? []).filter((item) => !isExclusive(group, item))
  const index = values.indexOf(value)
  if (index >= 0) values.splice(index, 1)
  else values.push(value)
  selection.value = { ...selection.value, [group.key]: values }
}
</script>

<template>
  <div class="mics-filter">
    <div v-for="group in groups" :key="group.key" class="mics-filter__row">
      <span class="mics-filter__label">
        <span
          class="mics-filter__marker"
          :class="isMulti(group) ? 'mics-filter__marker--multi' : 'mics-filter__marker--single'"
          :title="isMulti(group) ? '多选：选中多项需同时满足' : '单选：只能选一项'"
          aria-hidden="true"
        />
        {{ group.label }}
      </span>
      <div
        class="mics-chips"
        :role="isMulti(group) ? 'group' : 'radiogroup'"
        :aria-label="group.label"
      >
        <button
          v-for="option in group.options"
          :key="option.value"
          class="mics-chip"
          :class="{ 'is-active': isActive(group, option.value) }"
          :role="isMulti(group) ? undefined : 'radio'"
          :aria-checked="isMulti(group) ? undefined : isActive(group, option.value)"
          :aria-pressed="isMulti(group) ? isActive(group, option.value) : undefined"
          @click="choose(group, option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
  </div>
</template>
