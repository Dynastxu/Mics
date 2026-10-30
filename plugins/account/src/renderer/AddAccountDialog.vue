<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { AccountSummary } from '@mics/sdk'
import type { DeviceLoginPoll, DeviceLoginStart } from '../shared'

const props = defineProps<{
  open: boolean
  mode: 'microsoft' | 'offline'
  /** 重新登录已有正版账户时带上它的 id */
  replaceId?: string
  /** 打开后直接开始设备码登录（重新登录时使用） */
  autoStart?: boolean
}>()

const emit = defineEmits<{
  close: []
  added: [account: AccountSummary]
}>()

const ctx = usePluginContext()

const tab = ref<'microsoft' | 'offline'>(props.mode)
const offlineName = ref('')
const error = ref('')
const busy = ref(false)
const login = ref<DeviceLoginStart | null>(null)
const status = ref<'idle' | 'starting' | 'waiting' | 'error'>('idle')
/** 正版登录依赖部署方自己的 Azure 应用；未配置时先提示去填 client id */
const microsoftReady = ref(true)
const copied = ref(false)
/** 用户是否已经点过「复制并跳转至登录」；没点之前不显示「等待授权」 */
const opened = ref(false)

const offlineInput = ref<HTMLInputElement | null>(null)
const loginButton = ref<HTMLButtonElement | null>(null)

const title = computed(() => (props.replaceId ? '重新登录' : '添加账户'))
const waiting = computed(() => status.value === 'waiting' && login.value !== null)

let timer: ReturnType<typeof setInterval> | null = null
let polling = false

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function schedulePoll(seconds: number): void {
  stopPolling()
  timer = setInterval(() => {
    void poll()
  }, Math.max(3, seconds) * 1000)
}

function reset(): void {
  stopPolling()
  pollCancelled()
  tab.value = props.mode
  offlineName.value = ''
  error.value = ''
  busy.value = false
  login.value = null
  status.value = 'idle'
  copied.value = false
  opened.value = false
}

async function loadMicrosoftConfig(): Promise<void> {
  try {
    const config = await ctx.ipc.invoke<{ microsoftConfigured: boolean }>(
      'mics.account',
      'accounts/config',
    )
    microsoftReady.value = config.microsoftConfigured
  } catch {
    // 读不到配置时按已配置处理，真正的错误会在登录时给出
    microsoftReady.value = true
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 权限受限时退回 textarea 方案
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    try {
      return document.execCommand('copy')
    } finally {
      textarea.remove()
    }
  } catch {
    return false
  }
}

async function copyCode(): Promise<void> {
  const code = login.value?.userCode
  if (!code) return
  if (!(await copyText(code))) {
    error.value = '复制失败，请手动输入验证码'
    return
  }
  error.value = ''
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1500)
}

function pollCancelled(): void {
  const flow = login.value
  if (flow) {
    void ctx.ipc.invoke('mics.account', 'accounts/login/cancel', { flowId: flow.flowId })
      .catch(() => undefined)
  }
}

async function startMicrosoft(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  copied.value = false
  opened.value = false
  status.value = 'starting'
  try {
    const flow = await ctx.ipc.invoke<DeviceLoginStart>('mics.account', 'accounts/login/start', {
      ...(props.replaceId ? { replaceId: props.replaceId } : {}),
    })
    login.value = flow
    status.value = 'waiting'
    schedulePoll(flow.interval)
  } catch (cause) {
    status.value = 'error'
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

async function poll(): Promise<void> {
  const flow = login.value
  if (!flow || polling) return
  polling = true
  try {
    const result = await ctx.ipc.invoke<DeviceLoginPoll>('mics.account', 'accounts/login/poll', {
      flowId: flow.flowId,
    })
    if (result.status === 'pending') return

    stopPolling()
    if (result.status === 'done' && result.account) {
      login.value = null
      emit('added', result.account)
      emit('close')
      return
    }
    login.value = null
    status.value = 'error'
    error.value = result.error ?? '登录失败'
  } catch (cause) {
    stopPolling()
    login.value = null
    status.value = 'error'
    error.value = messageOf(cause)
  } finally {
    polling = false
  }
}

/** 复制验证码并打开登录页；复制失败也继续跳转，验证码在页面上仍然可见 */
async function copyAndOpen(): Promise<void> {
  const flow = login.value
  if (!flow) return
  error.value = ''
  opened.value = false

  const copiedOk = await copyText(flow.userCode)
  copied.value = copiedOk
  if (copiedOk) {
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  }

  try {
    await ctx.ipc.invoke('mics.kernel', 'host/openExternal', { url: flow.verificationUri })
    opened.value = true
  } catch (cause) {
    error.value = `打开浏览器失败（${messageOf(cause)}），请手动访问 ${flow.verificationUri}`
  }
}

async function addOffline(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const account = await ctx.ipc.invoke<AccountSummary>('mics.account', 'accounts/offline', {
      name: offlineName.value,
    })
    emit('added', account)
    emit('close')
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busy.value = false
  }
}

function switchTab(next: 'microsoft' | 'offline'): void {
  if (tab.value === next) return

  // 离开正版页签只暂停轮询：设备码仍然有效，切回来继续用同一个码
  if (tab.value === 'microsoft' && waiting.value) stopPolling()

  tab.value = next
  error.value = ''
  copied.value = false

  if (next === 'microsoft') {
    void resumeMicrosoft()
    return
  }
  void nextTick(() => offlineInput.value?.focus())
}

/** 切回正版页签：恢复同一个设备码的轮询，过期才要求重新开始 */
async function resumeMicrosoft(): Promise<void> {
  await loadMicrosoftConfig()

  const flow = login.value
  if (status.value === 'waiting' && flow) {
    if (Date.now() > flow.expiresAt) {
      pollCancelled()
      login.value = null
      status.value = 'idle'
      error.value = '登录码已过期，请重新开始'
      return
    }
    schedulePoll(flow.interval)
    return
  }

  await nextTick()
  loginButton.value?.focus()
}

function close(): void {
  if (busy.value) return
  stopPolling()
  pollCancelled()
  login.value = null
  emit('close')
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      stopPolling()
      pollCancelled()
      login.value = null
      return
    }
    reset()
    await nextTick()
    if (props.mode === 'offline') {
      offlineInput.value?.focus()
      return
    }
    await loadMicrosoftConfig()
    if (props.autoStart && microsoftReady.value) void startMicrosoft()
    else loginButton.value?.focus()
  },
)

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="account-dialog"
      role="presentation"
      @click.self="close"
      @keydown.esc.stop.prevent="close"
    >
      <div class="account-dialog__box" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <h2 id="account-dialog-title" class="account-dialog__title">{{ title }}</h2>

        <div v-if="!replaceId" class="mics-chips account-dialog__tabs">
          <button
            class="mics-chip"
            :class="{ 'is-active': tab === 'microsoft' }"
            type="button"
            @click="switchTab('microsoft')"
          >
            正版
          </button>
          <button
            class="mics-chip"
            :class="{ 'is-active': tab === 'offline' }"
            type="button"
            @click="switchTab('offline')"
          >
            离线
          </button>
        </div>

        <div v-if="tab === 'microsoft'" class="account-dialog__body">
          <template v-if="waiting && login">
            <div class="account-dialog__code-wrap">
              <p class="account-dialog__code">{{ login.userCode }}</p>
              <button
                class="account-dialog__copy"
                :class="{ 'is-copied': copied }"
                type="button"
                :title="copied ? '已复制' : '复制验证码'"
                :aria-label="copied ? '已复制' : '复制验证码'"
                @click="copyCode"
              >
                <svg
                  v-if="copied"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m20 6-11 11-5-5" />
                </svg>
                <svg
                  v-else
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              </button>
            </div>
            <p class="mics-muted account-dialog__uri">{{ login.verificationUri }}</p>
            <button class="mics-button mics-button--primary" type="button" @click="copyAndOpen">
              复制并跳转至登录
            </button>
            <p v-if="opened" class="mics-muted account-dialog__hint">等待浏览器授权…</p>
          </template>

          <template v-else>
            <button
              ref="loginButton"
              class="mics-button mics-button--primary"
              type="button"
              :disabled="busy || !microsoftReady"
              @click="startMicrosoft"
            >
              {{ status === 'starting' ? '正在获取登录码…' : '使用 Microsoft 登录' }}
            </button>
            <p v-if="!microsoftReady" class="account-dialog__hint">
              先在「插件管理 → 账户」填写以 Mics 注册的 Azure 应用 client id。
            </p>
          </template>
        </div>

        <form v-else class="account-dialog__body account-dialog__form" @submit.prevent="addOffline">
          <input
            ref="offlineInput"
            v-model="offlineName"
            class="mics-input"
            maxlength="16"
            placeholder="玩家名"
            spellcheck="false"
            aria-label="玩家名"
          />
          <button class="mics-button mics-button--primary" type="submit" :disabled="busy">
            添加
          </button>
        </form>

        <p v-if="error" class="mics-notice account-dialog__error">{{ error }}</p>

        <div class="account-dialog__footer">
          <button class="mics-button mics-button--ghost" type="button" :disabled="busy" @click="close">
            取消
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.account-dialog {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}

.account-dialog__box {
  width: min(420px, 100%);
  padding: 18px;
  border: 1px solid var(--mics-border);
  border-radius: 12px;
  background: var(--mics-bg-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
}

.account-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.account-dialog__tabs {
  margin-top: 14px;
}

.account-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}

.account-dialog__form {
  flex-direction: row;
}

.account-dialog__form .mics-input {
  flex: 1;
  min-width: 0;
}

.account-dialog__code-wrap {
  position: relative;
}

.account-dialog__code {
  margin: 0;
  /* 左右留同样的内边距：复制图标叠在右侧留白里，验证码仍然居中 */
  padding: 12px 44px;
  border: 1px dashed var(--mics-border);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-align: center;
}

.account-dialog__copy {
  position: absolute;
  top: 50%;
  right: 8px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--mics-fg-muted);
  transform: translateY(-50%);
  transition: color 0.12s ease, background 0.12s ease, border-color 0.12s ease;
}

.account-dialog__copy:hover {
  border-color: var(--mics-border);
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.account-dialog__copy:focus-visible {
  outline: 2px solid var(--mics-accent);
  outline-offset: 1px;
}

.account-dialog__copy.is-copied {
  color: var(--mics-accent);
}

.account-dialog__copy svg {
  width: 15px;
  height: 15px;
}

.account-dialog__uri {
  margin: 0;
  font-size: 12px;
  text-align: center;
  word-break: break-all;
}

.account-dialog__hint {
  margin: 0;
  font-size: 12px;
}

.account-dialog__error {
  margin: 14px 0 0;
  border-color: color-mix(in srgb, var(--mics-danger) 45%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
}

.account-dialog__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
