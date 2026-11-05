<script setup lang="ts">
/**
 * 设置分组模板：标题 / 说明 / 分组操作 + 一组设置行。
 *
 * 行内容放在默认插槽，默认包一层 `mics-form` 卡片；来源列表这类自带
 * 结构的块把 `form` 设为 false，或直接使用 `mics-section` 样式。
 */
withDefaults(
  defineProps<{
    title?: string
    description?: string
    /** 分组自己的加载 / 保存错误 */
    error?: string
    loading?: boolean
    /** 用 mics-form 卡片包住默认插槽 */
    form?: boolean
  }>(),
  { title: undefined, description: undefined, error: '', loading: false, form: true }
)
</script>

<template>
  <section class="mics-section">
    <div v-if="title || description || $slots.actions" class="settings-group__head">
      <div class="settings-group__heading">
        <h2 v-if="title" class="mics-section__title">{{ title }}</h2>
        <p v-if="description" class="settings-group__description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="settings-group__actions">
        <slot name="actions" />
      </div>
    </div>

    <p v-if="error" class="mics-notice settings-group__error">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取设置…</div>
    <div v-else-if="form" class="mics-form">
      <slot />
    </div>
    <slot v-else />
  </section>
</template>

<style scoped>
.settings-group__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.settings-group__heading {
  min-width: 0;
}

.settings-group__description {
  margin: 4px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.settings-group__actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.settings-group__error {
  margin: 0;
  border-color: var(--mics-danger);
  background: transparent;
  color: var(--mics-danger);
}
</style>
