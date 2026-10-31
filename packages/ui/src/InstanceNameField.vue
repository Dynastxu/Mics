<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { sanitizeInstanceName, validateInstanceName } from '@mics/sdk'
import type { InstanceNameCheck } from '@mics/sdk'

/**
 * 实例名称输入。
 *
 * 规则校验（非法字符 / 保留名 / 长度）在本地即时完成；重名要问主进程，
 * 由调用方通过 `check` 注入。这样组件本身不依赖 IPC，凡是要新建实例的页面
 * 都能复用同一套输入、即时清理与错误提示。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 输入为空时使用的默认名称（例如整合包名） */
    fallbackName?: string
    /** 名称可用性检查；通常调用主进程的 install/validate-name */
    checkName?: (name: string) => Promise<InstanceNameCheck>
    disabled?: boolean
    label?: string
    placeholder?: string
  }>(),
  {
    fallbackName: '',
    disabled: false,
    label: '实例名称',
    placeholder: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:check': [check: InstanceNameCheck]
}>()

const errorId = useId()
const draft = ref(props.modelValue)
const state = ref<InstanceNameCheck>({ ok: true, name: '' })

let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const effectiveName = computed(() => {
  const value = draft.value.trim().replace(/[. ]+$/, '')
  return value || props.fallbackName
})

const shownPlaceholder = computed(() => props.placeholder || props.fallbackName)

function publish(check: InstanceNameCheck): void {
  state.value = check
  emit('update:check', check)
}

async function runCheck(): Promise<InstanceNameCheck> {
  const current = ++seq
  const local = validateInstanceName(effectiveName.value)
  if (!local.ok || !props.checkName) {
    if (current === seq) publish(local)
    return local
  }

  try {
    const remote = await props.checkName(local.name)
    if (current === seq) publish(remote)
    return remote
  } catch {
    // 主进程查询失败时先按本地规则放行，提交时主进程仍会把关
    if (current === seq) publish(local)
    return local
  }
}

function schedule(delay = 220): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runCheck()
  }, delay)
}

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const sanitized = sanitizeInstanceName(input.value)
  if (sanitized !== input.value) {
    const caret = Math.max(0, (input.selectionStart ?? 0) - (input.value.length - sanitized.length))
    input.value = sanitized
    input.setSelectionRange(caret, caret)
  }
  draft.value = sanitized
  emit('update:modelValue', sanitized)
  schedule()
}

function normalize(): void {
  const normalized = draft.value.trim().replace(/[. ]+$/, '')
  if (normalized !== draft.value) {
    draft.value = normalized
    emit('update:modelValue', normalized)
  }
}

function onBlur(): void {
  normalize()
  void runCheck()
}

watch(
  () => props.modelValue,
  (value) => {
    if (value === draft.value) return
    draft.value = value
    schedule(0)
  },
)

watch(
  () => props.fallbackName,
  () => {
    if (!draft.value.trim()) schedule(0)
  },
)

onMounted(() => schedule(0))

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  seq += 1
})

defineExpose({ validate: runCheck })
</script>

<template>
  <div class="instance-name">
    <label v-if="label" class="instance-name__label" :for="errorId">{{ label }}</label>
    <input
      :id="errorId"
      class="mics-input instance-name__input"
      :class="{ 'is-invalid': !state.ok }"
      type="text"
      :value="draft"
      :placeholder="shownPlaceholder"
      :aria-invalid="!state.ok"
      :aria-describedby="state.ok ? undefined : `${errorId}-error`"
      :disabled="disabled"
      spellcheck="false"
      @input="onInput"
      @blur="onBlur"
    />
    <p v-if="!state.ok" :id="`${errorId}-error`" class="instance-name__error">
      {{ state.message }}
    </p>
  </div>
</template>

<style scoped>
.instance-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.instance-name__label {
  color: var(--mics-fg-muted);
  font-size: 11.5px;
}

.instance-name__input.is-invalid {
  border-color: var(--mics-danger);
}

.instance-name__error {
  margin: 0;
  color: var(--mics-danger);
  font-size: 11px;
  line-height: 1.4;
}
</style>
