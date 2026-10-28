import { reactive, shallowReactive } from 'vue'
import type { Component } from 'vue'
import type {
  AppInfo,
  CommandInfo,
  LayoutContribution,
  NavContribution,
  NavGroupContribution,
  PluginInfo,
  RuntimeSnapshot,
  StatusBarContribution,
  ThemeContribution,
} from '@mics/sdk'

/** 导航项：清单贡献 + 归属插件（用于按需激活与禁用态展示） */
export interface NavItem extends NavContribution {
  pluginId: string
}

/** 导航分组：分组本身由某个插件声明，子项来自任意插件 */
export interface NavGroup extends NavGroupContribution {
  pluginId: string
  items: NavItem[]
}

/** 左侧渲染顺序：顶层页面与分组按 order 混排 */
export type NavRoot =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; group: NavGroup }

export interface StatusItem extends StatusBarContribution {
  pluginId?: string
  source: 'manifest' | 'runtime'
}

export interface WorkbenchStore {
  ready: boolean
  bootError: string
  app?: AppInfo
  plugins: PluginInfo[]
  /** 全部导航项（顶层 + 分组内），按 order 排序 */
  nav: NavItem[]
  navGroups: NavGroup[]
  commands: CommandInfo[]
  themes: ThemeContribution[]
  runtimeStatus: StatusItem[]
  layout?: LayoutContribution
  themeId: string
  /** 当前页面对应的导航项 id */
  activeView: string
  navVisible: boolean
  paletteOpen: boolean
  /** 分组展开状态；缺省视为展开 */
  expandedGroups: Record<string, boolean>
  activating: Record<string, boolean>
  errors: Record<string, string>
}

export const store = reactive<WorkbenchStore>({
  ready: false,
  bootError: '',
  app: undefined,
  plugins: [],
  nav: [],
  navGroups: [],
  commands: [],
  themes: [],
  runtimeStatus: [],
  layout: undefined,
  themeId: '',
  activeView: '',
  navVisible: true,
  paletteOpen: false,
  expandedGroups: {},
  activating: {},
  errors: {},
})

/** viewId -> Vue 组件；由插件通过 ctx.ui.registerView 写入 */
export const viewComponents = shallowReactive<Record<string, Component>>({})

function byOrder(a: { order?: number; id: string }, b: { order?: number; id: string }): number {
  return (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id)
}

export function applySnapshot(snapshot: RuntimeSnapshot): void {
  store.app = snapshot.app
  // 插件管理需要看到全部插件（包括已禁用的），因此列表本身不过滤
  store.plugins = snapshot.plugins

  // 禁用的插件视同未安装：不再贡献导航、命令、主题、布局与状态栏
  const disabled = new Set(
    snapshot.plugins.filter((plugin) => plugin.state === 'disabled').map((plugin) => plugin.id),
  )
  const visiblePlugins = snapshot.plugins.filter((plugin) => !disabled.has(plugin.id))

  store.commands = snapshot.commands.filter(
    (command) => !command.pluginId || !disabled.has(command.pluginId),
  )

  const nav: NavItem[] = []
  const groups: NavGroup[] = []

  for (const plugin of visiblePlugins) {
    const contributes = plugin.manifest.contributes
    for (const item of contributes?.nav ?? []) {
      nav.push({ ...item, pluginId: plugin.id })
    }
    for (const group of contributes?.navGroups ?? []) {
      groups.push({ ...group, pluginId: plugin.id, items: [] })
    }
  }

  nav.sort(byOrder)

  for (const group of groups) {
    group.items = nav.filter((item) => item.group === group.id)
  }
  groups.sort(byOrder)

  store.nav = nav
  // 没有任何子项的分组不渲染（例如它的分类插件全被禁用/未安装）
  store.navGroups = groups.filter((group) => group.items.length > 0)

  store.themes = visiblePlugins.flatMap(
    (plugin) => plugin.manifest.contributes?.themes ?? [],
  )

  store.layout = visiblePlugins
    .flatMap((plugin) =>
      plugin.manifest.contributes?.layout ? [plugin.manifest.contributes.layout] : [],
    )
    .at(0)

  repairSelection()

  // 清理已消失插件的错误与激活标记
  const alive = new Set(snapshot.plugins.map((plugin) => plugin.id))
  for (const id of Object.keys(store.errors)) {
    if (!alive.has(id)) delete store.errors[id]
  }
  for (const id of Object.keys(store.activating)) {
    if (!alive.has(id)) delete store.activating[id]
  }
}

function repairSelection(): void {
  if (navItemById(store.activeView)) return
  const preferred = store.layout?.regions?.nav?.defaultView
  if (preferred && navItemById(preferred)) {
    store.activeView = preferred
    return
  }
  store.activeView = firstPageId()
}

function firstPageId(): string {
  const root = navRoots()[0]
  if (!root) return ''
  return root.kind === 'item' ? root.item.id : (root.group.items[0]?.id ?? '')
}

/** 左侧导航的渲染顺序：顶层页面与分组按 order 混排 */
export function navRoots(): NavRoot[] {
  const groupIds = new Set(store.navGroups.map((group) => group.id))
  const roots: NavRoot[] = [
    // 分组插件被禁用/卸载后，它的子页面退回顶层，避免其他插件的页面跟着消失
    ...store.nav
      .filter((item) => !item.group || !groupIds.has(item.group))
      .map((item): NavRoot => ({ kind: 'item', item })),
    ...store.navGroups.map((group): NavRoot => ({ kind: 'group', group })),
  ]
  return roots.sort((a, b) => {
    const left = a.kind === 'item' ? a.item : a.group
    const right = b.kind === 'item' ? b.item : b.group
    return byOrder(left, right)
  })
}

export function navItemById(id: string): NavItem | undefined {
  return store.nav.find((item) => item.id === id)
}

/** 分组是否展开：未记录时默认展开 */
export function isGroupExpanded(id: string): boolean {
  return store.expandedGroups[id] !== false
}

export function toggleGroup(id: string): void {
  store.expandedGroups[id] = !isGroupExpanded(id)
}

export function statusBarItems(): StatusItem[] {
  const declared: StatusItem[] = store.plugins
    .filter((plugin) => plugin.state !== 'disabled')
    .flatMap((plugin) =>
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

export function removeStyle(href: string): void {
  document.head.querySelector(`link[data-mics-style="${CSS.escape(href)}"]`)?.remove()
}

export function isDeclaredCommand(id: string): boolean {
  return store.plugins.some(
    (plugin) =>
      plugin.state !== 'disabled' &&
      plugin.manifest.contributes?.commands?.some((command) => command.id === id),
  )
}
