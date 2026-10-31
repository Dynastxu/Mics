<script setup lang="ts">
import { ref, watch } from 'vue'
import type { InstanceNameCheck } from '@mics/sdk'
import Dialog from './Dialog.vue'
import InstanceNameField from './InstanceNameField.vue'

/**
 * 「为新实例命名并安装」对话框。
 *
 * 与 Mod 的多实例选择不同，整合包安装会创建实例，因此只需要一个名称；
 * 名称输入、重名校验与提交状态都由这里统一处理。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    subtitle?: string
    /** 输入框默认值；一般是整合包名 */
    defaultName: string
    /** 名称可用性检查（主进程重名校验） */
    checkName?: (name: string) => Promise<InstanceNameCheck>
    installing?: boolean
    error?: string
    /** 安装前展示的版本信息，例如游戏版本 / 加载器 */
    details?: Array<{ label: string; value: string }>
    /** 明确的阻断原因（例如不支持的加载器） */
    blockedReason?: string
    submitLabel?: string
  }>(),
  {
    subtitle: '',
    installing: false,
    error: '',
    details: () => [],
    blockedReason: '',
    submitLabel: '安装',
  },
)

const emit = defineEmits<{
  close: []
  install: [name: string]
}>()

const name = ref('')
const check = ref<InstanceNameCheck>({ ok: true, name: '' })
const field = ref<InstanceType<typeof InstanceNameField> | null>(null)

function reset(): void {
  name.value = props.defaultName
  check.value = { ok: true, name: '' }
}

async function install(): Promise<void> {
  if (props.installing || props.blockedReason) return
  const result = field.value
    ? await field.value.validate()
    : check.value
  if (!result.ok) return
  emit('install', result.name)
}

function close(): void {
  if (props.installing) return
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
  { immediate: true },
)

const ready = () => check.value.ok && Boolean(check.value.name) && !props.blockedReason
</script>

<template>
  <Dialog :open="open" :title="title" :subtitle="subtitle" @close="close">
    <div class="instance-install">
      <dl v-if="details.length" class="instance-install__details">
        <template v-for="detail in details" :key="detail.label">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </template>
      </dl>

      <p v-if="blockedReason" class="mics-notice instance-install__error">{{ blockedReason }}</p>
      <p v-if="error" class="mics-notice instance-install__error">{{ error }}</p>

      <InstanceNameField
        ref="field"
        v-model="name"
        label="实例名称"
        :fallback-name="defaultName"
        :check-name="checkName"
        :disabled="installing"
        @update:check="check = $event"
      />
    </div>

    <template #footer>
      <span />
      <div class="instance-install__actions">
        <button
          class="mics-button mics-button--ghost"
          type="button"
          :disabled="installing"
          @click="close"
        >
          取消
        </button>
        <button
          class="mics-button mics-button--primary"
          type="button"
          :disabled="installing || !ready()"
          @click="install"
        >
          {{ installing ? '提交中…' : submitLabel }}
        </button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.instance-install {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.instance-install__details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--mics-border);
  border-radius: 9px;
  background: var(--mics-bg-hover);
  font-size: 11.5px;
}

.instance-install__details dt {
  color: var(--mics-fg-muted);
}

.instance-install__details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.instance-install__error {
  margin: 0;
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}

.instance-install__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
