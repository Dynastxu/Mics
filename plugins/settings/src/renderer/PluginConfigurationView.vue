<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type {
  ConfigurationPropertyInfo,
  ConfigurationValue,
  PluginConfigurationInfo,
} from '@mics/sdk'
import { ToggleSwitch } from '@mics/ui'

const ctx = usePluginContext()
const configs = ref<PluginConfigurationInfo[]>([])
const presence = computed(() => configs.value.length > 0)
const loading = ref(true)
const error = ref('')
const busy = ref<Record<string, boolean>>({})

function keyOf(config: PluginConfigurationInfo, property: ConfigurationPropertyInfo): string {
  return `${config.pluginId}:${property.key}`
}

function isBusy(config: PluginConfigurationInfo, property: ConfigurationPropertyInfo): boolean {
  return Boolean(busy.value[keyOf(config, property)])
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function replace(next: PluginConfigurationInfo): void {
  const index = configs.value.findIndex((config) => config.pluginId === next.pluginId)
  if (index >= 0) configs.value[index] = next
  else configs.value.push(next)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    configs.value = await ctx.ipc.invoke<PluginConfigurationInfo[]>('mics.kernel', 'configuration/list')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function save(
  config: PluginConfigurationInfo,
  property: ConfigurationPropertyInfo,
  value: unknown,
): Promise<void> {
  const key = keyOf(config, property)
  busy.value = { ...busy.value, [key]: true }
  error.value = ''
  try {
    replace(
      await ctx.ipc.invoke<PluginConfigurationInfo>('mics.kernel', 'configuration/set', {
        pluginId: config.pluginId,
        key: property.key,
        value,
      }),
    )
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = { ...busy.value, [key]: false }
  }
}

async function reset(
  config: PluginConfigurationInfo,
  property: ConfigurationPropertyInfo,
): Promise<void> {
  const key = keyOf(config, property)
  busy.value = { ...busy.value, [key]: true }
  error.value = ''
  try {
    replace(
      await ctx.ipc.invoke<PluginConfigurationInfo>('mics.kernel', 'configuration/reset', {
        pluginId: config.pluginId,
        key: property.key,
      }),
    )
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = { ...busy.value, [key]: false }
  }
}

function textOf(value: ConfigurationValue | undefined): string {
  return value === undefined ? '' : String(value)
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}

function numberValue(event: Event): number {
  return Number(inputValue(event))
}

function booleanValue(value: boolean): boolean {
  return value
}

onMounted(load)
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">插件配置</h1>
    </header>

    <p v-if="error" class="config__error">{{ error }}</p>
    <p v-if="loading" class="mics-muted">读取中…</p>
    <p v-else-if="!presence" class="mics-empty">没有插件声明配置项</p>

    <section v-for="config in configs" :key="config.pluginId" class="mics-section">
      <div class="config__heading">
        <h2 class="mics-section__title">{{ config.title ?? config.name }}</h2>
        <span class="mics-mono mics-muted">{{ config.pluginId }}</span>
      </div>
      <p v-if="config.description" class="mics-muted config__description">
        {{ config.description }}
      </p>

      <div class="mics-form">
        <div v-for="property in config.properties" :key="property.key" class="mics-field">
          <div>
            <div class="mics-field__label">{{ property.title ?? property.key }}</div>
            <div v-if="property.description" class="mics-field__hint">
              {{ property.description }}
            </div>
          </div>

          <div class="mics-field__control config__control">
            <ToggleSwitch
              v-if="property.type === 'boolean'"
              :model-value="Boolean(property.value)"
              :disabled="isBusy(config, property)"
              :label="property.title ?? property.key"
              @update:model-value="save(config, property, booleanValue($event))"
            />
            <select
              v-else-if="property.type === 'enum'"
              class="mics-select"
              :value="textOf(property.value)"
              :disabled="isBusy(config, property)"
              @change="save(config, property, inputValue($event))"
            >
              <option
                v-for="option in property.options ?? []"
                :key="String(option.value)"
                :value="option.value"
              >
                {{ option.label ?? option.value }}
              </option>
            </select>
            <input
              v-else-if="property.type === 'number' || property.type === 'integer'"
              class="mics-input"
              type="number"
              :value="textOf(property.value)"
              :min="property.minimum"
              :max="property.maximum"
              :disabled="isBusy(config, property)"
              @change="save(config, property, numberValue($event))"
            />
            <input
              v-else
              class="mics-input"
              type="text"
              :value="textOf(property.value)"
              :disabled="isBusy(config, property)"
              @change="save(config, property, inputValue($event))"
            />

            <span v-if="property.unit" class="mics-muted">{{ property.unit }}</span>
            <button
              v-if="property.source === 'user'"
              class="mics-button mics-button--ghost mics-button--small"
              :disabled="isBusy(config, property)"
              title="删除用户值，回退到默认值"
              @click="reset(config, property)"
            >
              恢复默认
            </button>
            <span v-else-if="property.source === 'profile'" class="mics-badge">profile</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.config__error {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}

.config__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.config__description {
  margin: 0;
  font-size: 12px;
}

.config__control {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
