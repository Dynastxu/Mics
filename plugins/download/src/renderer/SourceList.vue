<script setup lang="ts" generic="T extends { enabled: boolean }">
import { SettingsGroup, ToggleSwitch } from '@mics/ui'

defineProps<{
  items: T[]
  title: string
  note: string
  emptyText: string
  saved: boolean
  isDefault: boolean
  dragIndex: number
  overIndex: number
  toggleTitle: string
  getDisplayName: (index: number) => string
}>()

const emit = defineEmits<{
  add: []
  reset: []
  save: []
  edit: [index: number]
  delete: [index: number]
  toggle: [index: number, enabled: boolean]
  dragStart: [index: number, event: DragEvent]
  dragOver: [index: number, event: DragEvent]
  dragEnd: []
  drop: [index: number]
}>()
</script>

<template>
  <SettingsGroup :title="title" :description="note" :form="false">
    <template #actions>
      <button class="mics-button mics-button--ghost mics-button--small" @click="emit('add')">
        添加源
      </button>
      <button
        class="mics-button mics-button--ghost mics-button--small"
        title="恢复默认值"
        :disabled="isDefault"
        @click="emit('reset')"
      >
        重置
      </button>
      <button
        class="mics-button mics-button--small"
        :class="saved ? 'mics-button--ghost' : 'mics-button--primary'"
        :disabled="saved"
        @click="emit('save')"
      >
        {{ saved ? '已保存' : '保存' }}
      </button>
    </template>

    <div class="mics-list">
      <div v-if="items.length === 0" class="mics-empty">{{ emptyText }}</div>

      <div
        v-for="(item, index) in items"
        :key="index"
        class="settings-source"
        :class="{
          'settings-source--dragging': index === dragIndex,
          'settings-source--over': index === overIndex && index !== dragIndex,
          'settings-source--disabled': !item.enabled
        }"
        @dragover="emit('dragOver', index, $event)"
        @drop="emit('drop', index)"
      >
        <button
          class="settings-source__handle"
          type="button"
          title="拖拽排序"
          aria-label="拖拽排序"
          draggable="true"
          @dragstart="emit('dragStart', index, $event)"
          @dragend="emit('dragEnd')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
          >
            <line x1="8" y1="6" x2="16" y2="6" />
            <line x1="8" y1="12" x2="16" y2="12" />
            <line x1="8" y1="18" x2="16" y2="18" />
          </svg>
        </button>

        <slot name="before-name" :item="item" :index="index" />

        <span class="settings-source__name" :title="getDisplayName(index)">
          {{ getDisplayName(index) }}
        </span>

        <slot name="after-name" :item="item" :index="index" />

        <span v-if="!item.enabled" class="settings-source__state">已禁用</span>

        <div class="settings-source__actions">
          <button
            class="settings-source__action"
            type="button"
            title="编辑"
            aria-label="编辑"
            @click="emit('edit', index)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>

          <button
            class="settings-source__action settings-source__action--danger"
            type="button"
            title="删除"
            aria-label="删除"
            @click="emit('delete', index)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
          </button>

          <ToggleSwitch
            :model-value="item.enabled"
            :label="`${getDisplayName(index)}：${item.enabled ? '已启用' : '已禁用'}`"
            :title="toggleTitle"
            @update:model-value="emit('toggle', index, $event)"
          />
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>

<style scoped>
.settings-source {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--mics-border);
  transition:
    box-shadow 0.12s ease,
    opacity 0.12s ease;
}

.settings-source:last-child {
  border-bottom: 0;
}

.settings-source--dragging {
  opacity: 0.45;
}

.settings-source--over {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mics-accent) 55%, transparent);
}

.settings-source__handle,
.settings-source__action {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--mics-border);
  border-radius: 7px;
  background: transparent;
  color: var(--mics-fg-muted);
  transition:
    border-color 0.12s ease,
    background 0.12s ease,
    color 0.12s ease;
}

.settings-source__handle {
  cursor: grab;
}

.settings-source__handle:active {
  cursor: grabbing;
}

.settings-source__handle:hover,
.settings-source__action:hover {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.settings-source__handle:focus-visible,
.settings-source__action:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.settings-source__action--danger:hover {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, transparent);
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
  color: var(--mics-danger);
}

.settings-source__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--mics-fg);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-source--disabled .settings-source__name {
  color: var(--mics-fg-muted);
}

.settings-source__state {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.settings-source__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
