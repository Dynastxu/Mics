import type { Component } from 'vue'

/**
 * 追加到基础设置模板（SettingsPage）的一个分组。
 *
 * `component` 自己负责分组的标题、错误与行布局——通常直接返回一个
 * `<SettingsGroup>`，这样分组可以自行决定用不用 `mics-form` 卡片。
 */
export interface SettingsExtension {
  id: string
  component: Component
  props?: Record<string, unknown>
}
