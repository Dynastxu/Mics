/** 筛选面板里的一个可选值 */
export interface FilterOption {
  value: string
  label: string
}

/**
 * 筛选面板里的一组条件。
 *
 * - `single`：单选，只取一个值（状态、排序方式这类一行只有一个值的键）；
 * - `multi`：多选，选中多项时要求**同时满足**（例如形态：勾「页面」「后台」只剩两者都有的行）。
 *   面板上在组名左侧用实心圆 / 空心正方形标出单选与多选，选项本身只靠选中态表达。
 */
export interface FilterGroup {
  key: string
  label: string
  options: FilterOption[]
  mode?: 'single' | 'multi'
  /** multi 组里表示「全部」的选项：选中它即清空，其它选项不能与它同时选中 */
  exclusive?: string
  /**
   * 这组值的作用：`rows`（默认）参与行过滤，按 `ListRow.tags[key]` 匹配；
   * `order` 只交给 `sort` 回调读取（例如「排序方式」），不参与行过滤。
   */
  affects?: 'rows' | 'order'
}

/** 每组当前选中的值；multi 组为空数组表示「全部」 */
export type FilterSelection = Record<string, string[]>

/** 行内徽标 */
export interface BadgeItem {
  label: string
  /** 是否使用强调色 */
  accent?: boolean
}

/**
 * 列表的一行：只描述「这一行显示什么」，不绑定任何业务。
 *
 * 默认搜索会匹配 `label`、`badge`/`badges`、`meta`、`keywords` 与 `tags` 的值；
 * 默认筛选按 `tags[group.key]` 匹配（没有该字段的组不参与过滤）。
 */
export interface ListRow {
  /** 唯一键，select 事件回传 */
  id: string
  /** 主文本，例如版本号、实例名 */
  label: string
  /** 单个徽标，例如 正式版 / 稳定版；多个徽标请用 `badges` */
  badge?: string
  /** 单个徽标是否使用强调色 */
  badgeAccent?: boolean
  /** 多个徽标；传此字段后 `badge` / `badgeAccent` 被忽略 */
  badges?: BadgeItem[]
  /** 次要文本，例如发布日期 */
  meta?: string
  /** 额外参与默认搜索的文本 */
  keywords?: string[]
  /** 筛选分组值，key 与 FilterGroup.key 对应；一行有多值时用数组（例如同时有页面与后台） */
  tags?: Record<string, string | string[]>
  /** 左侧图片/头像 URL */
  img?: string
  /** 图片的 alt 文本 */
  imgAlt?: string
}

/**
 * 行语义：button = 整行点击进入；radio = 单选列表；checkbox = 多选列表；
 * static = 纯展示，不响应整行点击（操作放在 #actions 插槽里）。
 */
export type ListRowRole = 'button' | 'radio' | 'checkbox' | 'static'