<script setup lang="ts">
import { computed } from 'vue'

/**
 * shell 内置图标：清单里的 icon 写图标名（如 "download"），
 * 也可以在插件自己的页面里 import 不到它——页面内请使用文字或清单图标。
 * 未知名字会退化成单字符文本，方便插件临时用 emoji。
 */
const ICONS: Record<string, string> = {
  play: '<path d="M7 4.5v15l13-7.5-13-7.5Z" fill="currentColor" stroke="none"/>',
  download:
    '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  settings:
    '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/>' +
    '<path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/>' +
    '<path d="M4 18h9"/><path d="M17 18h3"/><circle cx="15" cy="18" r="2"/>',
  cube:
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
    '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  blocks:
    '<rect width="7" height="7" x="14" y="3" rx="1"/>' +
    '<path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/>' +
    '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/>' +
    '<path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>' +
    '<circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/>' +
    '<path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  plugin:
    '<path d="M12 2.5 15.5 6 12 9.5 8.5 6 12 2.5Z"/>' +
    '<path d="M5.5 9 9 12.5 5.5 16 2 12.5 5.5 9Z"/>' +
    '<path d="M18.5 9 22 12.5 18.5 16 15 12.5 18.5 9Z"/>' +
    '<path d="M12 15.5 15.5 19 12 22.5 8.5 19 12 15.5Z"/>',
  sliders:
    '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/>' +
    '<path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/>',
}

const props = withDefaults(defineProps<{ name?: string; size?: number }>(), {
  name: '',
  size: 18,
})

const glyph = computed(() => (props.name ? ICONS[props.name] : undefined))
</script>

<template>
  <svg
    v-if="glyph"
    class="mics-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="glyph"
  />
  <span v-else-if="name" class="mics-icon mics-icon--text" :style="{ fontSize: `${size - 1}px` }">
    {{ name }}
  </span>
</template>
