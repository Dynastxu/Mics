<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  name: string
  running: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    // 默认焦点放在「取消」上：删除是不可撤销操作，不应让回车直接触发
    cancelButton.value?.focus()
  },
)

function cancel(): void {
  if (props.busy) return
  emit('cancel')
}

function confirm(): void {
  if (props.busy) return
  emit('confirm')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="instance-delete"
      role="presentation"
      @click.self="cancel"
      @keydown.esc.stop.prevent="cancel"
    >
      <div
        class="instance-delete__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="instance-delete-title"
      >
        <h2 id="instance-delete-title" class="instance-delete__title">删除实例</h2>
        <p class="instance-delete__text">
          将删除「{{ name }}」的整个文件夹，包括存档、Mod、配置与日志。此操作不可恢复。
        </p>
        <p v-if="running" class="instance-delete__warning">该实例正在运行，删除前会先结束游戏进程。</p>

        <div class="instance-delete__actions">
          <button
            ref="cancelButton"
            class="mics-button mics-button--ghost"
            type="button"
            :disabled="busy"
            @click="cancel"
          >
            取消
          </button>
          <button
            class="mics-button mics-button--danger"
            type="button"
            :disabled="busy"
            @click="confirm"
          >
            {{ busy ? '正在删除…' : '删除' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.instance-delete {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.instance-delete__box {
  width: min(400px, 100%);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.instance-delete__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.instance-delete__text {
  margin: 8px 0 0;
  color: var(--mics-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.instance-delete__warning {
  margin: 8px 0 0;
  color: var(--mics-danger);
  font-size: 12px;
  line-height: 1.55;
}

.instance-delete__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
