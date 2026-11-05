<script setup lang="ts">
import { ref } from 'vue'
import { usePluginContext, useSettingsExtensions } from '@mics/sdk/renderer'
import { SettingsGroup, SettingsPage, SettingsRow } from '@mics/ui'

const ctx = usePluginContext()
const app = ctx.plugins.snapshot().app

const themes = ctx.theme.available()
const themeId = ref(ctx.theme.current() ?? themes[0]?.id ?? '')
const language = ref('zh-CN')

/** 其它插件追加到通用设置页的分组；排在页面自己的分组之后 */
const extensions = useSettingsExtensions('settings.general')

function changeTheme(event: Event): void {
  themeId.value = (event.target as HTMLSelectElement).value
  ctx.theme.apply(themeId.value)
}
</script>

<template>
  <SettingsPage title="通用" :extensions="extensions">
    <SettingsGroup title="外观">
      <SettingsRow label="主题" html-for="settings-theme">
        <select id="settings-theme" class="mics-select" :value="themeId" @change="changeTheme">
          <option v-for="theme in themes" :key="theme.id" :value="theme.id">
            {{ theme.label }}
          </option>
        </select>
      </SettingsRow>

      <SettingsRow label="语言" html-for="settings-language">
        <select id="settings-language" v-model="language" class="mics-select">
          <option value="zh-CN">简体中文</option>
        </select>
      </SettingsRow>
    </SettingsGroup>

    <template #footer>
      <SettingsGroup title="数据与运行环境">
        <SettingsRow v-if="app.profile" label="配置档">
          <span class="mics-badge">{{ app.profile }}</span>
        </SettingsRow>

        <SettingsRow label="数据目录">
          <span class="mics-mono mics-muted settings__path">{{ app.userDataPath }}</span>
        </SettingsRow>

        <SettingsRow label="运行时">
          <span class="mics-muted">
            Electron {{ app.electron }} · Chromium {{ app.chrome }} · Node {{ app.node }}
          </span>
        </SettingsRow>

        <SettingsRow label="平台">
          <span class="mics-muted">{{ app.platform }}</span>
        </SettingsRow>
      </SettingsGroup>
    </template>
  </SettingsPage>
</template>

<style scoped>
.settings__path {
  overflow-wrap: anywhere;
}
</style>
