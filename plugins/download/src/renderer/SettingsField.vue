<script setup lang="ts">
defineProps<{
  label: string
  hint?: string
}>()
</script>

<template>
  <div class="mics-field">
    <div>
      <div class="mics-field__label">{{ label }}</div>
      <div class="mics-field__hint">
        <slot name="hint">{{ hint }}</slot>
      </div>
    </div>
    <div class="mics-field__control">
      <slot />
    </div>
  </div>
</template>
