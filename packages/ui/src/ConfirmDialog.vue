<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Dialog from './Dialog.vue'

type ButtonVariant = 'primary' | 'danger' | 'ghost'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** 主提示文字；更复杂的内容放默认插槽 */
    message?: string
    /** 对话框宽度上限 */
    width?: string
    confirmLabel?: string
    cancelLabel?: string
    confirmVariant?: ButtonVariant
    cancelVariant?: ButtonVariant
    /** 打开时聚焦哪个按钮；危险操作建议 cancel */
    defaultFocus?: 'confirm' | 'cancel'
    /** 点击遮罩 / 按 Esc 时等同于哪个动作；默认取消 */
    dismissAction?: 'confirm' | 'cancel'
    busy?: boolean
    /** 忙碌时确认按钮上的文案 */
    busyLabel?: string
    checkboxLabel?: string
    checked?: boolean
    /** 为 false 时只能通过按钮选择 */
    dismissible?: boolean
  }>(),
  {
    message: '',
    width: '420px',
    confirmLabel: '确定',
    cancelLabel: '取消',
    confirmVariant: 'primary',
    cancelVariant: 'ghost',
    defaultFocus: 'confirm',
    dismissAction: 'cancel',
    busy: false,
    busyLabel: '',
    checkboxLabel: '',
    checked: false,
    dismissible: true
  }
)

const emit = defineEmits<{
  confirm: []
  cancel: []
  'update:checked': [checked: boolean]
}>()

const confirmButton = ref<HTMLButtonElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)

const confirmText = computed(() =>
  props.busy && props.busyLabel ? props.busyLabel : props.confirmLabel
)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    const target = props.defaultFocus === 'cancel' ? cancelButton.value : confirmButton.value
    target?.focus()
  }
)

function confirm(): void {
  if (props.busy) return
  emit('confirm')
}

function cancel(): void {
  if (props.busy) return
  emit('cancel')
}

function dismiss(): void {
  if (props.busy || !props.dismissible) return
  if (props.dismissAction === 'confirm') emit('confirm')
  else emit('cancel')
}

function onChecked(event: Event): void {
  emit('update:checked', (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <Dialog :open="open" :title="title" :width="width" @close="dismiss">
    <div class="confirm-dialog__body">
      <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
      <slot />
    </div>

    <template #footer>
      <label v-if="checkboxLabel" class="confirm-dialog__remember">
        <input :checked="checked" type="checkbox" :disabled="busy" @change="onChecked" />
        <span>{{ checkboxLabel }}</span>
      </label>
      <span v-else class="confirm-dialog__spacer" />

      <div class="confirm-dialog__actions">
        <button
          ref="cancelButton"
          class="mics-button"
          :class="`mics-button--${cancelVariant}`"
          type="button"
          :disabled="busy"
          @click="cancel"
        >
          {{ cancelLabel }}
        </button>
        <button
          ref="confirmButton"
          class="mics-button"
          :class="`mics-button--${confirmVariant}`"
          type="button"
          :disabled="busy"
          @click="confirm"
        >
          {{ confirmText }}
        </button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.confirm-dialog__message {
  margin: 0;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.confirm-dialog__remember {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  cursor: pointer;
}

.confirm-dialog__remember input {
  margin: 0;
  accent-color: var(--mics-accent);
}

.confirm-dialog__spacer {
  flex: 1;
}

.confirm-dialog__actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
</style>
