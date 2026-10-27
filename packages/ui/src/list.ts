import type { FilterGroup, FilterSelection, ListRow } from './types'

/**
 * 一组筛选条件的默认值：single 组取第一个选项，multi 组为「全部」。
 *
 * 调用方不需要自己拼 `{ sort: ['type'], nature: [] }`，同一份 groups 就能推导出默认选择。
 */
export function defaultSelection(groups: FilterGroup[]): FilterSelection {
  const selection: FilterSelection = {}
  for (const group of groups) {
    selection[group.key] =
      (group.mode ?? 'multi') === 'single' ? group.options.slice(0, 1).map((option) => option.value) : []
  }
  return selection
}

/** 当前选择是否偏离默认值（用于筛选按钮上的小圆点） */
export function isFilterActive(selection: FilterSelection, groups: FilterGroup[]): boolean {
  const defaults = defaultSelection(groups)
  return groups.some((group) => {
    const current = [...(selection[group.key] ?? [])].sort()
    const fallback = [...(defaults[group.key] ?? [])].sort()
    return (
      current.length !== fallback.length ||
      current.some((value, index) => value !== fallback[index])
    )
  })
}

/** 一行是否命中关键字；不传 `searchText` 时使用默认字段 */
export function matchesQuery(
  row: ListRow,
  query: string,
  searchText?: (row: ListRow) => string,
): boolean {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return true

  const haystack = searchText
    ? searchText(row)
    : [
        row.label,
        row.badge,
        ...(row.badges?.map((b) => b.label) ?? []),
        row.meta,
        ...(row.keywords ?? []),
        ...Object.values(row.tags ?? {}),
      ]
        .filter(Boolean)
        .join(' ')

  return haystack.toLowerCase().includes(keyword)
}

export interface FilterRowsOptions {
  /** 筛选分组；`selection` 里出现且非空的组才会参与过滤 */
  groups?: FilterGroup[]
  selection?: FilterSelection
  query?: string
  /** 覆盖默认搜索字段 */
  searchText?: (row: ListRow) => string
  /** 覆盖默认的 `tags` 匹配；查询关键字仍单独生效 */
  match?: (row: ListRow, selection: FilterSelection) => boolean
  /** 过滤后排序；`selection` 让「排序方式」这类分组可用 */
  sort?: (a: ListRow, b: ListRow, selection: FilterSelection) => number
}

/** 先按关键字、再按分组过滤，最后排序；返回新数组 */
export function filterRows(items: ListRow[], options: FilterRowsOptions = {}): ListRow[] {
  const { groups = [], selection = {}, query = '', searchText, match, sort } = options
  const activeKeys = groups
    .filter((group) => (group.affects ?? 'rows') === 'rows')
    .filter((group) => (selection[group.key] ?? []).length > 0)
    .map((group) => group.key)

  const rows = items.filter((row) => {
    if (!matchesQuery(row, query, searchText)) return false
    if (!activeKeys.length) return true
    if (match) return match(row, selection)
    return activeKeys.every((key) => (selection[key] ?? []).includes(row.tags?.[key] ?? ''))
  })

  return sort ? [...rows].sort((a, b) => sort(a, b, selection)) : rows
}