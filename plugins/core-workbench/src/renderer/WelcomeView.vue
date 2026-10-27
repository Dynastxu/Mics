<script setup lang="ts">
import { computed } from 'vue'
import { pluginIdOf } from '@mics/sdk'
import { usePluginContext } from '@mics/sdk/renderer'

const ctx = usePluginContext()
const version = computed(
  () => ctx.plugins.list().find((item) => item.id === pluginIdOf(ctx))?.version ?? '0.0.0',
)
</script>

<template>
  <div class="welcome">
    <h1 class="welcome__title">Mics</h1>
    <p class="welcome__subtitle">一切皆插件 · Cordis 驱动</p>

    <p class="welcome__text">
      这个窗口本身也是一个插件应用：内核 <code>mics.kernel</code> 由 bootstrap 挂载，
      工作台的布局、主题和这个页面来自 <code>mics.core-workbench</code>，
      其余插件按需激活。
    </p>

    <ul class="welcome__tips">
      <li><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> 命令面板</li>
      <li><kbd>Ctrl</kbd> + <kbd>B</kbd> 显示/隐藏侧边栏</li>
      <li><kbd>Ctrl</kbd> + <kbd>J</kbd> 显示/隐藏面板</li>
    </ul>

    <p class="welcome__meta">工作台插件 v{{ version }}</p>
  </div>
</template>

<style scoped>
.welcome {
  padding: 18px 12px;
}

.welcome__title {
  margin: 0;
  font-size: 22px;
  letter-spacing: 0.02em;
}

.welcome__subtitle {
  margin: 6px 0 16px;
  color: var(--mics-accent);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.welcome__text {
  margin: 0 0 16px;
  color: var(--mics-fg-muted);
  line-height: 1.7;
}

.welcome__text code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
  font-size: 12px;
}

.welcome__tips {
  margin: 0 0 18px;
  padding-left: 18px;
  color: var(--mics-fg-muted);
  line-height: 2;
}

kbd {
  padding: 1px 6px;
  border: 1px solid var(--mics-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--mics-bg-elevated);
  color: var(--mics-fg);
  font-family: inherit;
  font-size: 11px;
}

.welcome__meta {
  margin: 0;
  color: var(--mics-fg-muted);
  font-size: 11px;
  opacity: 0.7;
}
</style>
