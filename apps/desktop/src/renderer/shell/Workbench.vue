<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { getContext } from '../runtime/context'
import { store } from '../runtime/store'
import ActivityBar from './ActivityBar.vue'
import CommandPalette from './CommandPalette.vue'
import MainArea from './MainArea.vue'
import PanelArea from './PanelArea.vue'
import SidebarPane from './SidebarPane.vue'
import StatusBar from './StatusBar.vue'

/** 解析 ctrl+shift+p 这类组合键 */
function matchesBinding(binding: string, event: KeyboardEvent): boolean {
  const parts = binding
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const key = parts.pop() ?? ''
  const needCtrl = parts.includes('ctrl') || parts.includes('cmd') || parts.includes('meta')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')

  const pressed = event.key.toLowerCase()
  const normalizedKey = key === 'space' ? ' ' : key
  if (pressed !== normalizedKey) return false
  if (needCtrl !== (event.ctrlKey || event.metaKey)) return false
  if (needShift !== event.shiftKey) return false
  if (needAlt !== event.altKey) return false
  return true
}

function onKeydown(event: KeyboardEvent): void {
  if (!store.ready || event.defaultPrevented) return

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    store.paletteOpen = true
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    store.sidebarVisible = !store.sidebarVisible
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault()
    store.panelVisible = !store.panelVisible
    return
  }
  if (event.key === 'Escape' && store.paletteOpen) {
    store.paletteOpen = false
    return
  }

  const command = store.commands.find(
    (item) => item.keybinding && matchesBinding(item.keybinding, event),
  )
  if (command) {
    event.preventDefault()
    void getContext()
      .commands.execute(command.id)
      .catch(() => {})
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="mics-workbench">
    <div v-if="store.bootError" class="mics-boot mics-boot--error">
      <h1>启动失败</h1>
      <pre>{{ store.bootError }}</pre>
    </div>
    <div v-else-if="!store.ready" class="mics-boot">
      <span class="mics-boot__spinner" />
      正在启动内核…
    </div>
    <template v-else>
      <div class="mics-body">
        <ActivityBar />
        <SidebarPane v-if="store.sidebarVisible" />
        <MainArea />
      </div>
      <PanelArea v-if="store.panelVisible" />
      <StatusBar />
      <CommandPalette v-if="store.paletteOpen" />
    </template>
  </div>
</template>
