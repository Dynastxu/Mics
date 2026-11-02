<script setup lang="ts">
import { ref, watch } from 'vue'
import { ConfirmDialog } from '@mics/ui'

const props = defineProps<{
  open: boolean
  instanceName: string
}>()

const emit = defineEmits<{
  confirm: [dontAsk: boolean]
  cancel: [dontAsk: boolean]
}>()

const dontAsk = ref(false)

watch(
  () => props.open,
  (open) => {
    if (open) dontAsk.value = false
  }
)

function confirm(): void {
  emit('confirm', dontAsk.value)
}

function cancel(): void {
  emit('cancel', dontAsk.value)
}
</script>

<template>
  <ConfirmDialog
    :open="open"
    title="已启动"
    :message="`「${instanceName}」正在运行，仍要再次启动？`"
    confirm-label="仍要启动"
    checkbox-label="不再提示"
    :checked="dontAsk"
    width="380px"
    @update:checked="dontAsk = $event"
    @confirm="confirm"
    @cancel="cancel"
  />
</template>
