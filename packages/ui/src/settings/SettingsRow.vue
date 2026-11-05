<script setup lang="ts">
/**
 * 设置内容模板：一行「标题 / 说明 + 控件」。
 *
 * 控件放默认插槽；单位、勾选状态等跟着控件走，恢复默认等行尾操作放
 * `actions` 插槽，由模板统一推到行尾。
 */
withDefaults(
  defineProps<{
    label: string
    hint?: string
    /** 关联控件 id；提供时标题渲成 <label for>，点击标题聚焦控件 */
    htmlFor?: string
    /** 宽控件：控件换到标题下方并占满整行 */
    wide?: boolean
  }>(),
  { hint: undefined, htmlFor: undefined, wide: false }
)
</script>

<template>
  <div class="mics-field" :class="{ 'settings-row--wide': wide }">
    <div class="settings-row__heading">
      <label v-if="htmlFor" :for="htmlFor" class="mics-field__label">{{ label }}</label>
      <div v-else class="mics-field__label">{{ label }}</div>
      <div v-if="hint || $slots.hint" class="mics-field__hint">
        <slot name="hint">{{ hint }}</slot>
      </div>
    </div>

    <div class="mics-field__control">
      <slot />
      <div v-if="$slots.actions" class="settings-row__actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-row--wide {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 7px;
}

.settings-row--wide .mics-field__control {
  flex-wrap: wrap;
}

.settings-row__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
</style>
