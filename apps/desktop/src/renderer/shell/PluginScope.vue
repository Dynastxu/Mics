<script setup lang="ts">
import { provide } from 'vue'
import { PLUGIN_CONTEXT_KEY } from '@mics/sdk/renderer'
import { getContext } from '../runtime/context'

const props = defineProps<{ pluginId: string }>()

// 把插件自己的 cordis 作用域提供给视图组件，
// 组件里 usePluginContext() 拿到的 ctx 带有 pluginId 与全部服务
const scope = getContext().plugins.contextOf?.(props.pluginId)
if (scope) provide(PLUGIN_CONTEXT_KEY, scope)
</script>

<template>
  <slot />
</template>
