<script setup lang="ts">
import { computed } from 'vue'
import type { ServerEntry, ServerStatus } from '../shared'

const props = defineProps<{
  server: ServerEntry
  /** 还没查到结果时为空 */
  status?: ServerStatus
  refreshing: boolean
}>()

const emit = defineEmits<{
  refresh: []
  remove: []
}>()

type CardState = 'pending' | 'online' | 'offline' | 'error'

const address = computed(() => `${props.server.host}:${props.server.port}`)

const editionLabel = computed(() => (props.server.edition === 'bedrock' ? '基岩版' : 'Java 版'))

/** 查询失败与「服务器离线」是两件事：前者要看错误，后者是正常结果 */
const state = computed<CardState>(() => {
  if (props.status?.error) return 'error'
  if (!props.status) return 'pending'
  return props.status.online ? 'online' : 'offline'
})

const badgeLabel = computed(() => {
  switch (state.value) {
    case 'online':
      return '在线'
    case 'offline':
      return '离线'
    case 'error':
      return '查询失败'
    default:
      return '查询中'
  }
})

const players = computed(() => {
  const value = props.status?.players
  return value ? `${value.online} / ${value.max}` : '—'
})

const version = computed(() => props.status?.version || '—')

const updatedAt = computed(() => {
  const timestamp = props.status?.retrievedAt
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(timestamp))
})

const motd = computed(() => props.status?.motd ?? [])
const initial = computed(() => props.server.label.slice(0, 1).toUpperCase())
</script>

<template>
  <article class="mics-card server-card">
    <header class="mics-card__head">
      <div class="server-card__identity">
        <img
          v-if="status?.icon"
          class="server-card__icon"
          :src="status.icon"
          alt=""
          width="38"
          height="38"
        />
        <span v-else class="mics-avatar server-card__icon">{{ initial }}</span>
        <div class="server-card__names">
          <span class="mics-card__title">{{ server.label }}</span>
          <span class="mics-card__meta mics-mono">{{ address }}</span>
        </div>
      </div>
      <span class="mics-badge server-card__badge" :class="`server-card__badge--${state}`">
        {{ badgeLabel }}
      </span>
    </header>

    <p v-if="state === 'error'" class="server-card__motd server-card__motd--error">
      {{ status?.error }}
    </p>
    <p v-else-if="motd.length" class="server-card__motd">{{ motd.join('\n') }}</p>
    <p v-else class="server-card__motd mics-muted">—</p>

    <dl class="server-card__stats">
      <div class="server-card__stat">
        <dt>玩家</dt>
        <dd>{{ players }}</dd>
      </div>
      <div class="server-card__stat">
        <dt>版本</dt>
        <dd>{{ version }}</dd>
      </div>
      <div class="server-card__stat">
        <dt>更新</dt>
        <dd class="mics-mono">{{ updatedAt }}</dd>
      </div>
    </dl>

    <footer class="mics-card__foot">
      <span class="mics-card__meta">{{ editionLabel }}</span>
      <div class="server-card__actions">
        <button
          class="mics-button mics-button--ghost mics-button--small"
          :disabled="refreshing"
          @click="emit('refresh')"
        >
          {{ refreshing ? '刷新中…' : '刷新' }}
        </button>
        <button class="mics-button mics-button--danger mics-button--small" @click="emit('remove')">
          删除
        </button>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.server-card {
  min-width: 0;
}

.server-card__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.server-card__icon {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  object-fit: cover;
  /* 服务器图标是 64×64 的像素画，放大时保持硬边 */
  image-rendering: pixelated;
  font-size: 14px;
}

.server-card__names {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.server-card__names .mics-card__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-card__badge--online {
  background: color-mix(in srgb, var(--mics-accent) 14%, transparent);
  color: var(--mics-accent);
}

.server-card__badge--offline {
  color: var(--mics-fg-muted);
}

.server-card__badge--error {
  background: color-mix(in srgb, var(--mics-danger) 14%, transparent);
  color: var(--mics-danger);
}

.server-card__motd {
  flex: 1;
  display: -webkit-box;
  margin: 0;
  min-height: 2.4em;
  overflow: hidden;
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.server-card__motd--error {
  color: var(--mics-danger);
}

.server-card__stats {
  display: flex;
  gap: 18px;
  margin: 0;
}

.server-card__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.server-card__stat dt {
  color: var(--mics-fg-muted);
  font-size: 10.5px;
}

.server-card__stat dd {
  margin: 0;
  overflow: hidden;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-card__actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
</style>
