import type { FilterSelection } from './types'

/**
 * 通用内容目录的视图类型。
 *
 * Mod、整合包以及后续的资源包 / 数据包都是「搜索项目 -> 选择版本 -> 安装」的
 * 同一种交互。`CatalogBrowser` 只依赖这里的结构，不绑定具体 IPC 或来源。
 */

export interface CatalogSourceInfo {
  /** 来源标识；用于筛选值，页面自行解释 */
  kind: string
  label: string
  enabled: boolean
  ready: boolean
  hint?: string
}

export interface CatalogCategory {
  id: string
  label: string
}

export interface CatalogGameVersion {
  id: string
  type: string
}

export interface CatalogItem {
  /** 跨来源稳定的唯一键 */
  id: string
  source: string
  sourceLabel: string
  sourceApi?: string
  projectId: string
  slug: string
  name: string
  summary: string
  author: string
  icon: string
  downloads: number
  follows: number
  categories: string[]
  updated: string
  url: string
}

export interface CatalogDependency {
  projectId: string
  name: string
  versionId: string
  kind: 'required' | 'optional' | 'incompatible' | 'embedded'
  project?: CatalogItem
}

export interface CatalogVersion {
  id: string
  source: string
  projectId: string
  name: string
  versionNumber: string
  channel: string
  gameVersions: string[]
  loaders: string[]
  published: string
  fileName: string
  fileUrl: string
  sha1: string
  size: number
  downloads: number
  dependencies?: CatalogDependency[]
}

export interface CatalogSearchRequest {
  query: string
  source: string
  gameVersion: string
  loader: string
  category: string
  page: number
  pageSize: number
}

export interface CatalogSourceError {
  label: string
  message: string
}

export interface CatalogSearchResult {
  items: CatalogItem[]
  total: number
  page: number
  pageSize: number
  errors: CatalogSourceError[]
}

/** 从其它页面跳进目录时传递的一次性意图（实例 Mod 列表等） */
export interface CatalogIntent {
  project?: CatalogItem
  query: string
  name?: string
  fileName?: string
  gameVersion?: string
  loader?: string
  versionId?: string
}

export interface CatalogLoaderOption {
  value: string
  label: string
}

export interface CatalogOpenOptions {
  /** 详情页初始筛选（例如从实例的 MC 版本 / 加载器进入） */
  filter?: FilterSelection
  /** 是否把当前详情压入返回栈（前置跳转） */
  remember?: boolean
}

/** 目录条目数量：过亿显示「亿」，过万显示「万」 */
export function formatDownloads(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`
  if (value >= 10_000) return `${Math.round(value / 10_000)} 万`
  return value.toLocaleString('zh-CN')
}
