<script setup lang="ts">
import { computed, watch } from 'vue'
import { getContext } from '../runtime/context'
import { store, viewComponents, type NavItem } from '../runtime/store'
import PluginScope from './PluginScope.vue'

const props = defineProps<{ page: NavItem }>()

const component = computed(() => viewComponents[props.page.id])
const activating = computed(() => Boolean(store.activating[props.page.pluginId]))
const error = computed(() => store.errors[props.page.pluginId] ?? '')
const disabled = computed(
  () => store.plugins.find((plugin) => plugin.id === props.page.pluginId)?.state === 'disabled',
)

function activate(): void {
  void getContext()
    .plugins.activate(props.page.pluginId)
    .catch(() => {})
}

function enable(): void {
  void getContext()
    .plugins.enable(props.page.pluginId)
    .catch(() => {})
}

watch(
  () => [props.page.id, props.page.pluginId] as const,
  () => {
    // 被禁用的插件绝不会被页面自动拉起
    if (component.value || activating.value || error.value || disabled.value) return
    activate()
  },
  { immediate: true },
)
</script>

<template>
  <PluginScope v-if="component" :plugin-id="page.pluginId">
    <component :is="component" />
  </PluginScope>
  <div v-else-if="disabled" class="mics-empty">
    插件 {{ page.pluginId }} 已被禁用。
    <button class="mics-empty__action" @click="enable">启用插件</button>
  </div>
  <div v-else-if="activating" class="mics-empty">正在激活插件 {{ page.pluginId }}…</div>
  <div v-else-if="error" class="mics-empty mics-empty--error">插件激活失败：{{ error }}</div>
  <div v-else class="mics-empty">页面 {{ page.id }} 尚未提供组件</div>
</template>
