<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { usePluginContext } from '@mics/sdk/renderer'
import type { AccountSnapshot, AccountSummary } from '@mics/sdk'
import { ACCOUNT_CHANGED_TOPIC, ACCOUNT_KIND_LABELS } from '@mics/sdk'
import AddAccountDialog from './AddAccountDialog.vue'

const ctx = usePluginContext()

const accounts = ref<AccountSummary[]>([])
const activeId = ref<string | null>(null)
const loading = ref(true)
const error = ref('')

/** 等待二次确认移除的账户 id */
const confirming = ref('')

const dialogOpen = ref(false)
const dialogMode = ref<'microsoft' | 'offline'>('microsoft')
const dialogReplaceId = ref<string | undefined>()
const dialogAutoStart = ref(false)

const ACCENTS = ['', 'mics-avatar--amber', 'mics-avatar--teal', 'mics-avatar--rose']

function accent(index: number): string {
  return ACCENTS[index % ACCENTS.length] ?? ''
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function apply(snapshot: AccountSnapshot): void {
  accounts.value = snapshot.accounts
  activeId.value = snapshot.activeId
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    apply(await ctx.ipc.invoke<AccountSnapshot>('mics.account', 'accounts/list'))
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function setActive(account: AccountSummary): Promise<void> {
  error.value = ''
  try {
    apply(await ctx.ipc.invoke<AccountSnapshot>('mics.account', 'accounts/setActive', {
      id: account.id,
    }))
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function remove(account: AccountSummary): Promise<void> {
  confirming.value = ''
  error.value = ''
  try {
    apply(await ctx.ipc.invoke<AccountSnapshot>('mics.account', 'accounts/remove', {
      id: account.id,
    }))
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

function openAdd(): void {
  dialogMode.value = 'microsoft'
  dialogReplaceId.value = undefined
  dialogAutoStart.value = false
  dialogOpen.value = true
}

function relogin(account: AccountSummary): void {
  dialogMode.value = 'microsoft'
  dialogReplaceId.value = account.id
  dialogAutoStart.value = true
  dialogOpen.value = true
}

function closeDialog(): void {
  dialogOpen.value = false
}

function handleAdded(): void {
  void load()
}

let offChanged: (() => void) | null = null

onMounted(() => {
  offChanged = ctx.ipc.on(ACCOUNT_CHANGED_TOPIC, (payload) => {
    const snapshot = payload as AccountSnapshot | undefined
    if (snapshot && Array.isArray(snapshot.accounts)) apply(snapshot)
  })
  void load()
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">账户</h1>
      <div class="mics-page__actions">
        <button class="mics-button mics-button--primary mics-button--small" @click="openAdd">
          添加账户
        </button>
      </div>
    </header>

    <p v-if="error" class="mics-notice account__error">{{ error }}</p>

    <section class="mics-section">
      <h2 class="mics-section__title">账户 · {{ accounts.length }}</h2>

      <div v-if="loading" class="mics-empty">正在读取账户…</div>
      <div v-else-if="!accounts.length" class="mics-empty">还没有账户。</div>

      <div v-else class="mics-list">
        <div v-for="(account, index) in accounts" :key="account.id" class="mics-list__row">
          <span class="mics-avatar" :class="accent(index)">{{ account.name.slice(0, 1) }}</span>

          <div class="mics-list__main">
            <div class="account__name">
              {{ account.name }}
              <span class="mics-badge">{{ ACCOUNT_KIND_LABELS[account.kind] }}</span>
              <span v-if="account.id === activeId" class="mics-badge mics-badge--accent">当前</span>
              <span v-if="!account.authorized" class="mics-badge account__expired">需要重新登录</span>
            </div>
            <div class="mics-list__meta mics-mono">{{ account.uuid }}</div>
          </div>

          <div class="account__actions">
            <template v-if="confirming === account.id">
              <button class="mics-button mics-button--danger mics-button--small" @click="remove(account)">
                移除
              </button>
              <button class="mics-button mics-button--ghost mics-button--small" @click="confirming = ''">
                取消
              </button>
            </template>
            <template v-else>
              <button
                v-if="account.id !== activeId"
                class="mics-button mics-button--ghost mics-button--small"
                @click="setActive(account)"
              >
                设为当前
              </button>
              <button
                v-if="account.kind === 'microsoft'"
                class="mics-button mics-button--ghost mics-button--small"
                @click="relogin(account)"
              >
                重新登录
              </button>
              <button
                class="mics-button mics-button--ghost mics-button--small"
                @click="confirming = account.id"
              >
                移除
              </button>
            </template>
          </div>
        </div>
      </div>
    </section>

    <AddAccountDialog
      :open="dialogOpen"
      :mode="dialogMode"
      :replace-id="dialogReplaceId"
      :auto-start="dialogAutoStart"
      @close="closeDialog"
      @added="handleAdded"
    />
  </div>
</template>

<style scoped>
.account__error {
  border-color: color-mix(in srgb, var(--mics-danger) 45%, var(--mics-border));
  background: color-mix(in srgb, var(--mics-danger) 10%, transparent);
}

.account__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.account__expired {
  color: var(--mics-danger);
}

.account__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
