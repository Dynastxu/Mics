<script setup lang="ts">
import { ConfirmDialog } from '@mics/ui'

defineProps<{
  open: boolean
  name: string
  running: boolean
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
    title="删除实例"
    :message="`将删除「${name}」的整个文件夹，包括存档、Mod、配置与日志。此操作不可恢复。`"
    confirm-label="删除"
    confirm-variant="danger"
    :busy="busy"
    busy-label="正在删除…"
    default-focus="cancel"
    width="400px"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <p v-if="running" class="instance-delete__warning">该实例正在运行，删除前会先结束游戏进程。</p>
  </ConfirmDialog>
</template>

<style scoped>
.instance-delete__warning {
  margin: 0;
  color: var(--mics-danger);
  font-size: 12px;
  line-height: 1.55;
}
</style>
