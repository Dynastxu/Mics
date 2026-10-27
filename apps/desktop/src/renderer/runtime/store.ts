import { reactive, shallowReactive } from 'vue'
import type { Component } from 'vue'
import type {
  AppInfo,
  CommandInfo,
  LayoutContribution,
  PluginInfo,
  RuntimeSnapshot,
  StatusBarContribution,
  ThemeContribution,
  ViewContribution,
} from '@mics/sdk'

export interface ViewItem extends ViewContribution {
  pluginId: string
}

export interface StatusItem extends StatusBarContribution {
  pluginId?: string
  source: 'manifest' | 'runtime'
}

export interface WorkbenchStore {
  ready: boolean
  bootError: string
  app?: AppInfo
  plugins: PluginInfo[]
  views: ViewItem[]
  commands: CommandInfo[]
  themes: ThemeContribution[]
  runtimeStatus: StatusItem[]
  layout?: LayoutContribution
  themeId: string
  activeSidebarView: string
  activeMainView: string
  activePanelView: string
  sidebarVisible: boolean
  panelVisible: boolean
  paletteOpen: boolean
  activating: Record<string, boolean>
  errors: Record<string, string>
  activated: Record<string, boolean>
}

export const store = reactive<WorkbenchStore>({
  ready: false,
  bootError: '',
  app: undefined,
  plugins: [],
  views: [],
  commands: [],
  themes: [],
  runtimeStatus: [],
  layout: undefined,
  themeId: '',
  activeSidebarView: '',
  activeMainView: '',
  activePanelView: '',
  sidebarVisible: true,
  panelVisible: false,
  paletteOpen: false,
  activating: {},
  errors: {},
  activated: {},
})

/** viewId -> Vue 组件；由插件通过 ctx.ui.registerView 写入 */
export const viewComponents = shallowReactive<Record<string, Component>>({})

export function applySnapshot(snapshot: RuntimeSnapshot): void {
  store.app = snapshot.app
  store.plugins = snapshot.plugins
  store.commands = snapshot.commands

  store.views = snapshot.plugins
    .flatMap((plugin) =>
      (plugin.manifest.contributes?.views ?? []).map((view) => ({ ...view, pluginId: plugin.id })),
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

  store.themes = snapshot.plugins.flatMap(
    (plugin) => plugin.manifest.contributes?.themes ?? [],
  )

  store.layout = snapshot.plugins
    .flatMap((plugin) => (plugin.manifest.contributes?.layout ? [plugin.manifest.contributes.layout] : []))
    .at(0)

  repairSelection()

  // 清理已消失插件的错误与激活标记
  const alive = new Set(snapshot.plugins.map((plugin) => plugin.id))
  for (const id of Object.keys(store.errors)) {
    if (!alive.has(id)) delete store.errors[id]
  }
  for (const id of Object.keys(store.activated)) {
    if (!alive.has(id)) delete store.activated[id]
  }
  for (const id of Object.keys(store.activating)) {
    if (!alive.has(id)) delete store.activating[id]
  }
}

function repairSelection(): void {
  const sidebarViews = store.views.filter((view) => (view.region ?? 'sidebar') === 'sidebar')
  if (!sidebarViews.some((view) => view.id === store.activeSidebarView)) {
    store.activeSidebarView =
      store.layout?.regions?.sidebar?.defaultView ?? sidebarViews.at(0)?.id ?? ''
  }

  const mainViews = store.views.filter((view) => view.region === 'main')
  if (!mainViews.some((view) => view.id === store.activeMainView)) {
    store.activeMainView = mainViews.at(0)?.id ?? ''
  }

  const panelViews = store.views.filter((view) => view.region === 'panel')
  if (!panelViews.some((view) => view.id === store.activePanelView)) {
    store.activePanelView = panelViews.at(0)?.id ?? ''
  }
}

export function viewsOf(region: 'sidebar' | 'main' | 'panel'): ViewItem[] {
  return store.views.filter((view) => (view.region ?? 'sidebar') === region)
}

export function viewById(id: string): ViewItem | undefined {
  return store.views.find((view) => view.id === id)
}

export function statusBarItems(): StatusItem[] {
  const declared: StatusItem[] = store.plugins.flatMap((plugin) =>
    (plugin.manifest.contributes?.statusBar ?? []).map((item) => ({
      ...item,
      pluginId: plugin.id,
      source: 'manifest' as const,
    })),
  )
  return [...declared, ...store.runtimeStatus].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function ensureStyle(href: string): void {
  if (document.head.querySelector(`link[data-mics-style="${CSS.escape(href)}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.micsStyle = href
  document.head.append(link)
}

export function isDeclaredCommand(id: string): boolean {
  return store.plugins.some((plugin) =>
    plugin.manifest.contributes?.commands?.some((command) => command.id === id),
  )
}
