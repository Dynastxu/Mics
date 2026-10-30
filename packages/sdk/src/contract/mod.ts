/**
 * Mod 下载子系统共享类型。
 *
 * Mod 目录与游戏版本下载不同：同一个 Mod 可能同时存在于多个平台（Modrinth /
 * CurseForge），每个平台有自己的项目 id、文件 id 与分类体系。这里定义的是
 * 「多个来源合并之后」的统一视图，页面不需要知道具体平台的接口形状。
 */

/** Mod 下载源类型 */
export const MOD_SOURCE_KINDS = ['modrinth', 'curseforge'] as const

export type ModSourceKind = (typeof MOD_SOURCE_KINDS)[number]

/** 来源显示名；设置页、搜索筛选与结果徽标共用 */
export const MOD_SOURCE_LABELS: Record<ModSourceKind, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
}

export function isModSourceKind(value: unknown): value is ModSourceKind {
  return typeof value === 'string' && (MOD_SOURCE_KINDS as readonly string[]).includes(value)
}

/**
 * Mod 下载源：与原版下载源一样，条目顺序稳定、可在设置中增删与排序。
 *
 * `api` 是可替换的接口根地址（镜像只需提供同构接口）；`key` 只对需要鉴权的
 * 来源有意义，当前仅 CurseForge 使用。留空时按来源的官方地址回退。
 */
export interface ModSource {
  label: string
  kind: ModSourceKind
  api: string
  /** 接口密钥；不需要鉴权的来源留空 */
  key: string
  /** 是否参与搜索；关闭后该源被跳过 */
  enabled: boolean
}

/** 默认 Mod 下载源（顺序即列表中的展示顺序） */
export const DEFAULT_MOD_SOURCES: ReadonlyArray<ModSource> = [
  {
    label: 'Modrinth',
    kind: 'modrinth',
    api: 'https://api.modrinth.com/v2',
    key: '',
    enabled: true,
  },
  {
    label: 'CurseForge',
    kind: 'curseforge',
    api: 'https://api.curseforge.com/v1',
    key: '',
    enabled: true,
  },
]

/** 某个来源的官方接口根地址 */
export function defaultModApi(kind: ModSourceKind): string {
  return DEFAULT_MOD_SOURCES.find((source) => source.kind === kind)?.api ?? ''
}

/**
 * 该来源是否强制要求 API Key。
 *
 * 只有官方 CurseForge 接口强制鉴权；自建或第三方代理可能不需要 Key，
 * 设置页与主进程必须用同一份判断，避免「设置里说缺 Key、实际却能搜」。
 */
export function modSourceNeedsKey(source: Pick<ModSource, 'kind' | 'api'>): boolean {
  if (source.kind !== 'curseforge') return false
  const api = source.api.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(api) ? api : `https://${api}`
  try {
    return new URL(withScheme).hostname === 'api.curseforge.com'
  } catch {
    return true
  }
}

/**
 * 把持久化/外部来源的 Mod 下载源归一化成当前契约。
 *
 * 未知来源类型会被丢弃，接口地址留空时回退到该来源的官方地址；
 * 旧条目没有 `key` / `enabled` 时补成空串与开启。
 */
export function normalizeModSources(value: unknown): ModSource[] {
  if (!Array.isArray(value)) return DEFAULT_MOD_SOURCES.map((source) => ({ ...source }))
  const sources: ModSource[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (!isModSourceKind(record.kind)) continue
    const api = typeof record.api === 'string' ? record.api.trim() : ''
    sources.push({
      label: typeof record.label === 'string' ? record.label : '',
      kind: record.kind,
      api: api || defaultModApi(record.kind),
      key: typeof record.key === 'string' ? record.key.trim() : '',
      enabled: record.enabled !== false,
    })
  }
  return sources
}

/** 搜索页需要的来源信息；不包含密钥 */
export interface ModSourceInfo {
  kind: ModSourceKind
  label: string
  enabled: boolean
  /** 是否已经具备发起搜索的条件（例如 CurseForge 需要 API Key） */
  ready: boolean
  /** 不可用原因；可用时为空 */
  hint?: string
}

/**
 * 从实例 Mod 列表跳到 Mod 目录详情时传递的一次性意图。
 *
 * 路由没有参数，渲染端插件之间用全局 key 传递；消费者读取后立即删除，
 * 避免下一次打开 Mod 页时再次自动进入详情。
 */
export interface ModOpenIntent {
  /** 有精确识别结果时直接打开该项目，不再搜索 */
  project?: ModSummary
  /** 没有精确结果时使用的搜索关键字 */
  query: string
  /** 期望匹配的展示名 */
  name?: string
  /** 实例里的文件名，用于人工排查 */
  fileName?: string
  /** 实例的 MC 版本与加载器，用于详情页初始筛选 */
  gameVersion?: string
  loader?: ModLoader | 'all'
  /** 本地文件对应的确切版本 */
  versionId?: string
}

export const MOD_OPEN_INTENT_KEY = '__MICS_MOD_OPEN_INTENT__'

/** Mod 加载器标识，与启动页 / 加载器安装共用同一套命名 */
export const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'] as const

export type ModLoader = (typeof MOD_LOADERS)[number]

export const MOD_LOADER_LABELS: Record<ModLoader, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
}

export function isModLoader(value: unknown): value is ModLoader {
  return typeof value === 'string' && (MOD_LOADERS as readonly string[]).includes(value)
}

/** 统一的 Mod 类型（跨来源映射后的分类） */
export interface ModCategory {
  id: string
  label: string
}

/** 搜索请求：页面 -> 主进程 */
export interface ModSearchRequest {
  /** 名称关键字；空串表示不按名称过滤 */
  query: string
  /** 来源筛选；all 表示所有已启用的来源 */
  source: ModSourceKind | 'all'
  /** 目标游戏版本；空串表示全部 */
  gameVersion: string
  /** 目标加载器；all 表示全部 */
  loader: ModLoader | 'all'
  /** 统一的类型 id；空串表示全部 */
  category: string
  /** 1 起算的页码 */
  page: number
  pageSize: number
}

/** 合并后的搜索结果条目 */
export interface ModSummary {
  /** `${source}:${projectId}`，跨页稳定的唯一键 */
  id: string
  source: ModSourceKind
  /** 来源显示名（允许用户在设置里改名） */
  sourceLabel: string
  /** 产生该结果的来源接口地址；用于多镜像时锁定具体来源 */
  sourceApi?: string
  projectId: string
  slug: string
  name: string
  summary: string
  author: string
  /** 图标 URL；没有时为空串 */
  icon: string
  downloads: number
  follows: number
  /** 已转换成本地显示名的类型标签 */
  categories: string[]
  updated: string
  /** 项目主页 */
  url: string
}

/** 单个来源的失败原因；其它来源的结果仍然可用 */
export interface ModSourceError {
  source: ModSourceKind
  label: string
  message: string
}

export interface ModSearchResult {
  items: ModSummary[]
  /** 所有参与来源的总条数 */
  total: number
  page: number
  pageSize: number
  errors: ModSourceError[]
}

/** 项目文件（版本）查询请求 */
export interface ModVersionRequest {
  source: ModSourceKind
  /** 具体来源接口；多镜像时用于避免串源 */
  sourceApi?: string
  projectId: string
  /** 固定筛选：目标游戏版本；空串表示全部 */
  gameVersion: string
  /** 固定筛选：目标加载器；all 表示全部 */
  loader: ModLoader | 'all'
}

/** 送去指纹识别的一个本地文件 */
export interface ModIdentifyFile {
  /** 调用方自己的唯一键，通常是文件名 */
  key: string
  /** Modrinth SHA1 */
  sha1?: string
  /** CurseForge MurmurHash2 */
  murmur2?: number
}

/** 指纹识别结果：本地文件与某个来源项目的精确对应 */
export interface ModIdentity {
  key: string
  source: ModSourceKind
  /** 命中的具体来源接口；多镜像时用它锁定后续版本查询 */
  sourceApi: string
  sourceLabel: string
  projectId: string
  versionId: string
  project: ModSummary
}

export interface ModIdentifyRequest {
  files: ModIdentifyFile[]
}

/** Mod 文件的发布渠道 */
export type ModReleaseChannel = 'release' | 'beta' | 'alpha'

export interface ModVersion {
  /** `${source}:${fileId}`；同一项目内唯一 */
  id: string
  source: ModSourceKind
  projectId: string
  /** 展示名，例如 `Sodium 0.6.13` */
  name: string
  versionNumber: string
  channel: ModReleaseChannel
  gameVersions: string[]
  loaders: ModLoader[]
  /** 发布日期，ISO 8601 */
  published: string
  fileName: string
  fileUrl: string
  /** SHA1；来源没有提供时为空串 */
  sha1: string
  size: number
  downloads: number
}

/** 一次 Mod 安装要落盘的文件 */
export interface ModFileRef {
  url: string
  fileName: string
  sha1?: string
  size?: number
}

/**
 * 安装请求：把同一个文件写进多个实例的 mods/ 目录。
 *
 * 主进程只登记下载任务并立即返回 jobId，真正的传输在下载页展示。
 */
export interface ModInstallRequest {
  file: ModFileRef
  instanceNames: string[]
  /** 下载页标题，例如 `Sodium 0.9.2` */
  title?: string
  /** 下载页副标题，例如 `2 个实例` */
  detail?: string
}
