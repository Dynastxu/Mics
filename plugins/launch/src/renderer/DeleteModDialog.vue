<script setup lang="ts">
import { ConfirmDialog } from '@mics/ui'

defineProps<{
  open: boolean
  name: string
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <ConfirmDialog
    :open="open"
    title="删除 Mod"
    :message="`将删除文件「${name}」。此操作不可恢复，但如果只是临时停用，请使用右侧开关。`"
    confirm-label="删除"
    confirm-variant="danger"
    :busy="busy"
    busy-label="正在删除…"
    default-focus="cancel"
    width="420px"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  />
</template>
