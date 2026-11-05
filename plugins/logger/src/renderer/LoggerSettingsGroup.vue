<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import {
  DEFAULT_LOG_MAX_FILES,
  MAX_LOG_MAX_FILES,
  MIN_LOG_MAX_FILES,
  normalizeLogMaxFiles
} from '@mics/sdk'
import type { LogStatus } from '@mics/sdk'
import { SettingsGroup, SettingsRow } from '@mics/ui'

const ctx = usePluginContext()
const DEFAULT_MAX = String(DEFAULT_LOG_MAX_FILES)
const loading = ref(true)
const error = ref('')
const maxFiles = ref(DEFAULT_MAX)
const directory = ref('')
const file = ref('')

const RANGE = `${MIN_LOG_MAX_FILES}–${MAX_LOG_MAX_FILES}`
const currentFile = computed(() => file.value.split(/[\\/]/).pop() ?? file.value)

function applyStatus(status: LogStatus): void {
  maxFiles.value = String(status.maxFiles)
  directory.value = status.directory
  file.value = status.file
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function load(): Promise<void> {
  try {
    applyStatus(await ctx.ipc.invoke<LogStatus>('mics.logger', 'settings/get'))
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  maxFiles.value = String(normalizeLogMaxFiles(maxFiles.value))
  error.value = ''
  try {
    applyStatus(
      await ctx.ipc.invoke<LogStatus>('mics.logger', 'settings/set', {
        maxFiles: Number(maxFiles.value)
      })
    )
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function reset(): Promise<void> {
  maxFiles.value = DEFAULT_MAX
  await save()
}

async function openDirectory(): Promise<void> {
  error.value = ''
  try {
    await ctx.ipc.invoke('mics.logger', 'directory/open')
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

onMounted(load)
</script>

<template>
  <SettingsGroup title="日志" :loading="loading" :error="error">
    <SettingsRow
      label="保留文件数"
      :hint="`每次启动生成一个日志文件，超出后删除最旧的（${RANGE}）`"
      html-for="logger-max-files"
    >
      <input
        id="logger-max-files"
        v-model="maxFiles"
        class="mics-input"
        inputmode="numeric"
        @change="save"
      />
      <template #actions>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          title="恢复默认值"
          :disabled="maxFiles === DEFAULT_MAX"
          @click="reset"
        >
          重置
        </button>
      </template>
    </SettingsRow>

    <SettingsRow label="日志目录">
      <span class="mics-mono mics-muted logger__path" :title="directory">{{ directory }}</span>
      <template #actions>
        <button
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="!directory"
          @click="openDirectory"
        >
          打开目录
        </button>
      </template>
    </SettingsRow>

    <SettingsRow label="当前日志">
      <span class="mics-mono mics-muted logger__path" :title="file">{{ currentFile }}</span>
    </SettingsRow>
  </SettingsGroup>
</template>

<style scoped>
.logger__path {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
