<script setup lang="ts">
import { computed, watch } from 'vue'
import { getContext } from '../runtime/context'
import { store, viewComponents, type ViewItem } from '../runtime/store'
import PluginScope from './PluginScope.vue'

const props = defineProps<{ view: ViewItem }>()

const component = computed(() => viewComponents[props.view.id])
const activating = computed(() => Boolean(store.activating[props.view.pluginId]))
const error = computed(() => store.errors[props.view.pluginId] ?? '')
const disabled = computed(
  () => store.plugins.find((plugin) => plugin.id === props.view.pluginId)?.state === 'disabled',
)

function activate(): void {
  void getContext()
    .plugins.activate(props.view.pluginId)
    .catch(() => {})
}

function enable(): void {
  void getContext()
    .plugins.enable(props.view.pluginId)
    .catch(() => {})
}

watch(
  () => [props.view.id, props.view.pluginId] as const,
  () => {
    // 被禁用的插件绝不会被视图自动拉起
    if (component.value || activating.value || error.value || disabled.value) return
    activate()
  },
  { immediate: true },
)
</script>

<template>
  <PluginScope v-if="component" :plugin-id="view.pluginId">
    <component :is="component" />
  </PluginScope>
  <div v-else-if="disabled" class="mics-empty">
    插件 {{ view.pluginId }} 已被禁用。
    <button class="mics-empty__action" @click="enable">启用插件</button>
  </div>
  <div v-else-if="activating" class="mics-empty">正在激活插件 {{ view.pluginId }}…</div>
  <div v-else-if="error" class="mics-empty mics-empty--error">插件激活失败：{{ error }}</div>
  <div v-else class="mics-empty">视图 {{ view.id }} 尚未提供组件</div>
</template>
