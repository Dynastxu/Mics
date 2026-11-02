<script setup lang="ts">
import { ConfirmDialog } from '@mics/ui'
import { closePrompt, respondClosePrompt } from './state'
</script>

<template>
  <ConfirmDialog
    :open="closePrompt.open"
    title="关闭应用"
    message="关闭主窗口后要做什么？"
    confirm-label="最小化至托盘区"
    cancel-label="退出应用"
    :busy="closePrompt.busy"
    checkbox-label="不再提示"
    :checked="closePrompt.remember"
    default-focus="confirm"
    :dismissible="false"
    width="420px"
    @update:checked="closePrompt.remember = $event"
    @confirm="respondClosePrompt('tray')"
    @cancel="respondClosePrompt('quit')"
  >
    <p class="close-prompt__hint">最小化到托盘后，应用会继续在后台运行。</p>
    <p v-if="closePrompt.error" class="close-prompt__error">{{ closePrompt.error }}</p>
  </ConfirmDialog>
</template>

<style scoped>
.close-prompt__hint,
.close-prompt__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
}

.close-prompt__hint {
  color: var(--mics-fg-muted);
}

.close-prompt__error {
  color: var(--mics-danger);
}
</style>
