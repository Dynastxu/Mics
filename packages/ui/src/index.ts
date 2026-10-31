/**
 * @mics/ui —— 插件共用的 UI 组件。
 *
 * 组件直接复用 shell 的设计系统类（mics-list / mics-toolbar / mics-filter / mics-chip / mics-button），
 * 使用它的插件需要在 plugin.json 里声明 `styles`：组件自带的 scoped 样式会一起进
 * 插件的 dist/style.css。
 *
 * 这里放的是「纯 Vue 组件」：不依赖 cordis，也不做运行时注册，
 * 插件在自己的 bundle 里静态引入即可（类型完整、按需打包）。
 */
export { default as BackToTop } from './BackToTop.vue'
export { default as CatalogBrowser } from './CatalogBrowser.vue'
export { default as CatalogCard } from './CatalogCard.vue'
export { default as DataBrowser } from './DataBrowser.vue'
export { default as DataList } from './DataList.vue'
export { default as Dialog } from './Dialog.vue'
export { default as FilterButton } from './FilterButton.vue'
export { default as FilterPanel } from './FilterPanel.vue'
export { default as InstanceInstallDialog } from './InstanceInstallDialog.vue'
export { default as InstanceNameField } from './InstanceNameField.vue'
export { default as ListPager } from './ListPager.vue'
export { default as ToggleSwitch } from './ToggleSwitch.vue'
export { defaultSelection, filterRows, isFilterActive, matchesQuery } from './list'
export type { FilterRowsOptions } from './list'
export { formatDownloads } from './catalog'
export type {
  CatalogCategory,
  CatalogDependency,
  CatalogGameVersion,
  CatalogIntent,
  CatalogItem,
  CatalogLoaderOption,
  CatalogOpenOptions,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSourceError,
  CatalogSourceInfo,
  CatalogVersion,
} from './catalog'
export type {
  BadgeItem,
  FilterGroup,
  FilterOption,
  FilterSelection,
  ListRow,
  ListRowRole,
} from './types'
