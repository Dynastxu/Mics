<script setup lang="ts">
import type { SettingsExtension } from './types'

/**
 * 基础设置模板：所有设置页共用同一套页面壳。
 *
 * 页面自己的分组写在默认插槽里，按书写顺序渲染；其它插件通过
 * `ctx.ui.registerSettingsGroup({ pageId })` 追加的分组紧跟其后。
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 追加到本页的分组；由 useSettingsExtensions(pageId) 包装后传入 */
    extensions?: SettingsExtension[]
    loading?: boolean
    error?: string
  }>(),
  { extensions: () => [], loading: false, error: '', description: undefined }
)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <div class="settings-page__heading">
        <h1 class="mics-page__title">{{ title }}</h1>
        <p v-if="description" class="mics-page__note">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="mics-page__actions">
        <slot name="actions" />
      </div>
    </header>

    <p v-if="error" class="mics-notice settings-page__error">{{ error }}</p>

    <div v-if="loading" class="mics-empty">正在读取设置…</div>
    <template v-else>
      <slot />
      <component
        :is="extension.component"
        v-for="extension in extensions"
        :key="extension.id"
        v-bind="extension.props"
      />
      <slot name="footer" />
    </template>
  </div>
</template>

<style scoped>
.settings-page__heading {
  min-width: 0;
}

.settings-page__error {
  margin: 0;
  border-color: var(--mics-danger);
  background: transparent;
  color: var(--mics-danger);
}
</style>
