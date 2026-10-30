import type { FilterGroup, FilterSelection, ListRow } from './types'

/**
 * 一组筛选条件的默认值：single 组取第一个选项，multi 组为「全部」。
 *
 * 调用方不需要自己拼 `{ sort: ['type'], nature: [] }`，同一份 groups 就能推导出默认选择。
 */
export function defaultSelection(groups: FilterGroup[]): FilterSelection {
  const selection: FilterSelection = {}
  for (const group of groups) {
    const first = group.options[0]
    // 单选组取第一个选项，但「全部」意味着不过滤，默认仍是空
    selection[group.key] =
      (group.mode ?? 'multi') === 'single' && first && first.value !== group.exclusive
        ? [first.value]
        : []
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

/** 行内某个筛选键的所有取值：允许一个键挂多个值 */
export function tagValues(row: ListRow, key: string): string[] {
  const value = row.tags?.[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
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
        ...Object.keys(row.tags ?? {}).flatMap((key) => tagValues(row, key)),
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
  const activeGroups = groups
    .filter((group) => (group.affects ?? 'rows') === 'rows')
    .filter((group) => (selection[group.key] ?? []).length > 0)

  const rows = items.filter((row) => {
    if (!matchesQuery(row, query, searchText)) return false
    if (!activeGroups.length) return true
    if (match) return match(row, selection)
    // 多选按「同时满足」合并：每个选中值都要在行上（一行可以有多个 tag 值）
    return activeGroups.every((group) => {
      const chosen = selection[group.key] ?? []
      const values = tagValues(row, group.key)
      return chosen.every((value) => values.includes(value))
    })
  })

  return sort ? [...rows].sort((a, b) => sort(a, b, selection)) : rows
}