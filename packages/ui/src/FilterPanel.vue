<script setup lang="ts">
import type { FilterGroup, FilterSelection } from './types'

defineProps<{ groups: FilterGroup[] }>()

/** 每组选中的值；multi 组为空数组表示「全部」 */
const selection = defineModel<FilterSelection>({ required: true })

function isExclusive(group: FilterGroup, value: string): boolean {
  return Boolean(group.exclusive) && group.exclusive === value
}

function isActive(group: FilterGroup, value: string): boolean {
  const values = selection.value[group.key] ?? []
  return isExclusive(group, value) ? values.length === 0 : values.includes(value)
}

function choose(group: FilterGroup, value: string): void {
  if ((group.mode ?? 'multi') === 'single') {
    selection.value = { ...selection.value, [group.key]: [value] }
    return
  }

  if (isExclusive(group, value)) {
    selection.value = { ...selection.value, [group.key]: [] }
    return
  }

  // 「全部」与具体选项互斥：选中具体选项时先把它剔除
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
      <span class="mics-filter__label">{{ group.label }}</span>
      <div
        class="mics-chips"
        :role="(group.mode ?? 'multi') === 'single' ? 'radiogroup' : 'group'"
        :aria-label="group.label"
      >
        <button
          v-for="option in group.options"
          :key="option.value"
          class="mics-chip"
          :class="{ 'is-active': isActive(group, option.value) }"
          :role="(group.mode ?? 'multi') === 'single' ? 'radio' : undefined"
          :aria-checked="
            (group.mode ?? 'multi') === 'single' ? isActive(group, option.value) : undefined
          "
          :aria-pressed="
            (group.mode ?? 'multi') !== 'single' ? isActive(group, option.value) : undefined
          "
          @click="choose(group, option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
  </div>
</template>
