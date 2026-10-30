<script setup lang="ts">
import { ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type {
  ConfigurationPropertyInfo,
  ConfigurationValue,
  PluginConfigurationInfo,
} from '@mics/sdk'
import { ToggleSwitch } from '@mics/ui'

/**
 * 清单 schema 的设置表单。
 *
 * 数据来自内核 `configuration/list|set|reset`：插件详情的配置区与 agent
 * 读的是同一份默认值与校验规则，因此这里不自己存值，只把结果回传给父组件。
 */
const props = defineProps<{ config: PluginConfigurationInfo }>()
const emit = defineEmits<{ updated: [config: PluginConfigurationInfo] }>()

const ctx = usePluginContext()
const error = ref('')
const busy = ref<Record<string, boolean>>({})

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isBusy(property: ConfigurationPropertyInfo): boolean {
  return Boolean(busy.value[property.key])
}

async function apply(
  method: 'configuration/set' | 'configuration/reset',
  property: ConfigurationPropertyInfo,
  value?: ConfigurationValue,
): Promise<void> {
  busy.value = { ...busy.value, [property.key]: true }
  error.value = ''
  try {
    emit(
      'updated',
      await ctx.ipc.invoke<PluginConfigurationInfo>('mics.kernel', method, {
        pluginId: props.config.pluginId,
        key: property.key,
        value,
      }),
    )
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = { ...busy.value, [property.key]: false }
  }
}

function save(property: ConfigurationPropertyInfo, value: ConfigurationValue): void {
  void apply('configuration/set', property, value)
}

function reset(property: ConfigurationPropertyInfo): void {
  void apply('configuration/reset', property)
}

function textOf(value: ConfigurationValue | undefined): string {
  return value === undefined ? '' : String(value)
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}

function booleanValue(value: boolean): boolean {
  return value
}
</script>

<template>
  <div class="settings">
    <p v-if="error" class="settings__error">{{ error }}</p>

    <div v-for="property in config.properties" :key="property.key" class="mics-field">
      <div>
        <div class="mics-field__label">{{ property.title ?? property.key }}</div>
        <div v-if="property.description" class="mics-field__hint">
          {{ property.description }}
        </div>
      </div>

      <div class="mics-field__control settings__control">
        <ToggleSwitch
          v-if="property.type === 'boolean'"
          :model-value="Boolean(property.value)"
          :disabled="isBusy(property)"
          :label="property.title ?? property.key"
          @update:model-value="save(property, booleanValue($event))"
        />
        <select
          v-else-if="property.type === 'enum'"
          class="mics-select"
          :value="textOf(property.value)"
          :disabled="isBusy(property)"
          @change="save(property, inputValue($event))"
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
          :disabled="isBusy(property)"
          @change="save(property, Number(inputValue($event)))"
        />
        <input
          v-else
          class="mics-input"
          type="text"
          :value="textOf(property.value)"
          :disabled="isBusy(property)"
          @change="save(property, inputValue($event))"
        />

        <span v-if="property.unit" class="mics-muted">{{ property.unit }}</span>
        <button
          v-if="property.source === 'user'"
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="isBusy(property)"
          title="删除用户值，回退到默认值"
          @click="reset(property)"
        >
          恢复默认
        </button>
        <span v-else-if="property.source === 'profile'" class="mics-badge">profile</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings__error {
  margin: 0 0 8px;
  padding: 9px 12px;
  border: 1px solid var(--mics-danger);
  border-radius: 8px;
  color: var(--mics-danger);
  font-size: 12px;
}

.settings__control {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
