<script setup lang="ts">
import { ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'

const ctx = usePluginContext()
const app = ctx.plugins.snapshot().app

const themes = ctx.theme.available()
const themeId = ref(ctx.theme.current() ?? themes[0]?.id ?? '')
const language = ref('zh-CN')

function changeTheme(event: Event): void {
  themeId.value = (event.target as HTMLSelectElement).value
  ctx.theme.apply(themeId.value)
}
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">通用</h1>
    </header>

    <section class="mics-section">
      <h2 class="mics-section__title">外观</h2>
      <div class="mics-form">
        <div class="mics-field">
          <div class="mics-field__label">主题</div>
          <div class="mics-field__control">
            <select class="mics-select" :value="themeId" @change="changeTheme">
              <option v-for="theme in themes" :key="theme.id" :value="theme.id">
                {{ theme.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="mics-field">
          <div class="mics-field__label">语言</div>
          <div class="mics-field__control">
            <select v-model="language" class="mics-select">
              <option value="zh-CN">简体中文</option>
            </select>
          </div>
        </div>
      </div>
    </section>

    <section class="mics-section">
      <h2 class="mics-section__title">数据与运行环境</h2>
      <div class="mics-form">
        <div class="mics-field">
          <div class="mics-field__label">数据目录</div>
          <div class="mics-field__control">
            <span class="mics-mono mics-muted settings__path">{{ app.userDataPath }}</span>
          </div>
        </div>

        <div class="mics-field">
          <div class="mics-field__label">运行时</div>
          <div class="mics-field__control">
            <span class="mics-muted">
              Electron {{ app.electron }} · Chromium {{ app.chrome }} · Node {{ app.node }}
            </span>
          </div>
        </div>

        <div class="mics-field">
          <div class="mics-field__label">平台</div>
          <div class="mics-field__control">
            <span class="mics-muted">{{ app.platform }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings__path {
  overflow-wrap: anywhere;
}
</style>
