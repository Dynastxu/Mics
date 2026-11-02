<script setup lang="ts">
import { computed } from 'vue'
import { ConfirmDialog } from '@mics/ui'
import type { MissingFile } from '../shared'

const props = defineProps<{
  open: boolean
  instanceName: string
  files: MissingFile[]
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

/** 只列前几项，避免一个坏掉的实例把弹窗撑得比屏幕还高 */
const PREVIEW_LIMIT = 3
const preview = computed(() => props.files.slice(0, PREVIEW_LIMIT))
const remaining = computed(() => Math.max(0, props.files.length - PREVIEW_LIMIT))
</script>

<template>
  <ConfirmDialog
    :open="open"
    title="文件不完整"
    :message="`「${instanceName}」缺少 ${files.length} 个必要文件，补全后才能启动。`"
    confirm-label="补全并下载"
    width="400px"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <ul v-if="files.length" class="missing-files__list">
      <li v-for="file in preview" :key="file.path">{{ file.label }}</li>
      <li v-if="remaining" class="missing-files__more">还有 {{ remaining }} 个…</li>
    </ul>
  </ConfirmDialog>
</template>

<style scoped>
.missing-files__list {
  margin: 0;
  padding: 10px 12px;
  max-height: 132px;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--mics-border);
  border-radius: 8px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}

.missing-files__more {
  opacity: 0.7;
}
</style>
