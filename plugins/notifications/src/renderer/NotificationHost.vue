<script setup lang="ts">
import { dismissNotification, notificationItems } from './state'
</script>

<template>
  <div class="notification-host" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="notification">
      <div
        v-for="item in notificationItems"
        :key="item.id"
        class="notification"
        :class="`notification--${item.level}`"
        :role="item.level === 'error' ? 'alert' : 'status'"
      >
        <div class="notification__body">
          <div v-if="item.title" class="notification__title">{{ item.title }}</div>
          <div class="notification__message">{{ item.message }}</div>
        </div>
        <button
          class="notification__close"
          type="button"
          aria-label="关闭通知"
          @click="dismissNotification(item.id)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.notification-host {
  position: fixed;
  right: 16px;
  bottom: 42px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}

.notification {
  --notification-accent: var(--mics-accent);
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 10px 11px 13px;
  border: 1px solid var(--mics-border);
  border-left: 3px solid var(--notification-accent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--mics-bg-elevated) 94%, transparent);
  box-shadow: 0 14px 36px rgb(0 0 0 / 0.42);
  backdrop-filter: blur(12px);
}

.notification--success {
  --notification-accent: #34d399;
}

.notification--warning {
  --notification-accent: #fbbf24;
}

.notification--error {
  --notification-accent: var(--mics-danger);
}

.notification__body {
  flex: 1;
  min-width: 0;
}

.notification__title {
  margin-bottom: 3px;
  color: var(--mics-fg);
  font-size: 12.5px;
  font-weight: 600;
}

.notification__message {
  color: var(--mics-fg-muted);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.notification__close {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--mics-fg-muted);
}

.notification__close:hover {
  background: var(--mics-bg-hover);
  color: var(--mics-fg);
}

.notification-enter-active,
.notification-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.notification-enter-from,
.notification-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.notification-move {
  transition: transform 0.16s ease;
}
</style>
