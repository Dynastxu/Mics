<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DownloadManualAction } from '@mics/sdk'
import { usePluginContext, useOpenExternal } from '@mics/sdk/renderer'
import { Dialog } from '@mics/ui'

/**
 * 作者关闭第三方分发时的待办清单。
 *
 * 与 Prism 的流程一致：逐个打开文件页下载，安装监视系统下载目录，
 * 校验通过后勾选；齐全后自动继续安装。这里只提供手动入口与「重新检查」。
 */
const props = defineProps<{
  open: boolean
  action: DownloadManualAction | null
  jobId: string
}>()

const emit = defineEmits<{
  close: []
  checked: []
}>()

const ctx = usePluginContext()
const openExternal = useOpenExternal()

const checking = ref(false)
const notice = ref('')

const missing = computed(
  () => props.action?.files.filter((file) => file.state !== 'verified') ?? []
)
const requiredMissing = computed(() => missing.value.filter((file) => !file.optional).length)

const subtitle = computed(() => {
  if (!props.action || props.action.files.length === 0) return ''
  if (requiredMissing.value === 0) return '必需文件已齐，安装将继续'
  return `还剩 ${requiredMissing.value} 个必需文件`
})

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '大小未知'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function openPage(url: string): Promise<void> {
  if (!url) return
  notice.value = ''
  try {
    await openExternal(url)
  } catch (cause) {
    notice.value = `打开文件页失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function openFolder(): Promise<void> {
  const folder = props.action?.folder
  if (!folder) return
  notice.value = ''
  try {
    await ctx.ipc.invoke('mics.kernel', 'host/openPath', { path: folder })
  } catch (cause) {
    notice.value = `打开文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function check(): Promise<void> {
  const action = props.action
  if (!action || checking.value) return
  checking.value = true
  notice.value = ''
  try {
    await ctx.ipc.invoke(action.check.target, action.check.method, { jobId: props.jobId })
    emit('checked')
  } catch (cause) {
    notice.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <Dialog :open="open" title="需要手动下载" :subtitle="subtitle" @close="emit('close')">
    <p v-if="notice" class="mics-notice mics-notice--error">{{ notice }}</p>

    <p class="manual-hint">
      以下文件的作者关闭了第三方分发，只能从 CurseForge 文件页下载。文件会保存到下方文件夹，
      校验通过后自动继续安装。
    </p>

    <div v-if="action && action.files.length > 0" class="manual-list">
      <div
        v-for="file in action.files"
        :key="file.fileName"
        class="manual-file"
        :class="{ 'manual-file--done': file.state === 'verified' }"
      >
        <span class="manual-file__state" aria-hidden="true">
          {{ file.state === 'verified' ? '✓' : '○' }}
        </span>
        <span class="manual-file__main">
          <span class="manual-file__name" :title="file.fileName">{{ file.fileName }}</span>
          <span class="manual-file__meta">
            {{ fmtSize(file.size) }}<template v-if="file.optional"> · 可选</template>
          </span>
        </span>
        <button
          v-if="file.state !== 'verified'"
          class="mics-button mics-button--ghost mics-button--small"
          type="button"
          :disabled="!file.pageUrl"
          :title="file.pageUrl ? '在浏览器打开文件页' : '来源没有提供文件页'"
          @click="openPage(file.pageUrl)"
        >
          下载
        </button>
        <span v-else class="manual-file__done">已就位</span>
      </div>
    </div>

    <p v-if="action" class="manual-folder" :title="action.folder">
      保存位置：<code>{{ action.folder }}</code>
    </p>

    <template #footer>
      <div class="manual-footer">
        <button
          class="mics-button mics-button--ghost mics-button--small"
          type="button"
          :disabled="!action"
          @click="openFolder"
        >
          打开文件夹
        </button>
        <div class="manual-footer__right">
          <button
            class="mics-button mics-button--ghost"
            type="button"
            :disabled="checking"
            @click="emit('close')"
          >
            关闭
          </button>
          <button
            class="mics-button mics-button--primary"
            type="button"
            :disabled="checking || !action"
            @click="check"
          >
            {{ checking ? '检查中…' : '重新检查' }}
          </button>
        </div>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.manual-hint {
  margin: 0 0 12px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.6;
}

.manual-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--mics-border);
  border-radius: 9px;
}

.manual-file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--mics-border);
}

.manual-file:last-child {
  border-bottom: 0;
}

.manual-file__state {
  flex: none;
  width: 16px;
  color: var(--mics-fg-muted);
  font-size: 12px;
  text-align: center;
}

.manual-file--done .manual-file__state {
  color: var(--mics-accent);
}

.manual-file__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.manual-file__name {
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manual-file__meta {
  color: var(--mics-fg-muted);
  font-size: 11px;
}

.manual-file__done {
  flex: none;
  color: var(--mics-accent);
  font-size: 11.5px;
}

.manual-folder {
  margin: 10px 0 0;
  color: var(--mics-fg-muted);
  font-size: 11px;
  word-break: break-all;
}

.manual-folder code {
  font-size: 11px;
}

.manual-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.manual-footer__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mics-notice--error {
  margin-bottom: 12px;
  border-color: color-mix(in srgb, var(--mics-danger) 40%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 8%, transparent);
  color: var(--mics-danger);
}
</style>
