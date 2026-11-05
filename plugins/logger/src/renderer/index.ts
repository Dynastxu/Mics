import type { Context } from 'cordis'
import { GENERAL_SETTINGS_PAGE } from '@mics/sdk'
import { defineRendererPlugin } from '@mics/sdk/renderer'
import LoggerSettingsGroup from './LoggerSettingsGroup.vue'

export const name = 'mics.logger'
export const inject = ['ui', 'ipc']

export function apply(ctx: Context): void {
  // 日志设置不是独立页面：作为分组追加到通用设置页，保留数量、目录与当前日志在同一处
  ctx.ui.registerSettingsGroup({
    id: 'logger',
    pageId: GENERAL_SETTINGS_PAGE,
    title: '日志',
    order: 30,
    component: LoggerSettingsGroup
  })
}

export default defineRendererPlugin({ name, inject, apply })
