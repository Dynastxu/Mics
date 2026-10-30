/**
 * 下载子系统共享类型。
 *
 * 这些类型是主进程（下载管线、下载源）与渲染进程（下载页面 UI）
 * 之间通过 IPC 交换数据的通用契约。
 */

/** 下载源提供的游戏版本摘要 */
export interface GameVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_alpha' | 'old_beta'
  /** 发布日期，ISO 8601 */
  releaseTime: string
  /** 该版本的 manifest URL */
  url: string
}

/** 加载器类型标识 */
export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge'

/** 可安装的加载器（不含原版），也是下载源必须声明的类型 */
export const LOADER_SOURCE_KINDS = ['fabric', 'forge', 'neoforge'] as const

export type LoaderSourceKind = (typeof LOADER_SOURCE_KINDS)[number]

/** 加载器显示名；主进程日志与渲染进程徽标共用 */
export const LOADER_LABELS: Record<LoaderKind, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
}

export function isLoaderSourceKind(value: unknown): value is LoaderSourceKind {
  return typeof value === 'string' && (LOADER_SOURCE_KINDS as readonly string[]).includes(value)
}

/** 加载器版本摘要 */
export interface LoaderVersion {
  id: string
  /** 对应游戏版本 */
  gameVersion: string
  /** 稳定版 / 测试版 */
  channel: 'stable' | 'beta'
  /** 发布日期 */
  date: string
}

/** 加载器选项 */
export interface LoaderOption {
  id: LoaderKind
  label: string
  /** 该加载器可用的版本列表（在选定游戏版本后查询） */
  versions: LoaderVersion[]
}

/** 下载任务状态 */
export type DownloadTaskState =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'done'
  | 'failed'

/** 下载任务进度 */
export interface DownloadProgress {
  /** 已下载字节 */
  loaded: number
  /** 总字节；-1 表示未知 */
  total: number
  /** 下载速度（字节/秒） */
  speed: number
  /** 文件名或简短描述 */
  label: string
}

/** 一个下载任务的当前状态 */
export interface DownloadTask {
  id: string
  /** 所属的整体安装任务 id */
  installId: string
  url: string
  savePath: string
  /** SHA1 校验值；空字符串表示跳过校验 */
  sha1: string
  size: number
  label: string
  state: DownloadTaskState
  progress: DownloadProgress
  error?: string
  /** 创建时间戳 */
  createdAt: number
}

/**
 * 安装任务的生命周期。
 *
 * - `preparing`：已受理，正在后台构建下载清单（版本详情、资源索引、任务列表）
 * - `ready`：下载清单已就绪，进度由各 task 状态推导
 * - `done`：全部文件下载并校验完成，实例已写入 `ready` 安装标记，可以启动
 * - `failed` / `cancelled`：终态，`error` 说明原因；失败的安装可以重试或删除
 *
 * 旧版本持久化的任务没有该字段，读取时按 `ready` 处理。
 */
export type InstallJobState = 'preparing' | 'ready' | 'done' | 'failed' | 'cancelled'

/**
 * 安装方式。
 *
 * - `install`：新建实例目录并下载全部文件；
 * - `repair`：实例目录已存在，只检查并补下缺失文件。
 */
export type InstallMode = 'install' | 'repair'

/** 一次安装的聚合进度；下载页只依赖这份汇总，不拉取逐文件任务 */
export interface InstallJobStats {
  /** 任务总数 */
  total: number
  /** 排队中（不含已暂停） */
  waiting: number
  paused: number
  /** 下载 / 校验中的文件数 */
  downloading: number
  done: number
  failed: number
  /** failed 中由取消产生的数量 */
  cancelled: number
  loaded: number
  /** 预计总字节；未知大小的任务按 size 或 0 计 */
  bytes: number
  /** 0–100 */
  percent: number
}

/** 一组关联的下载任务（一次安装操作） */
export interface InstallJob {
  id: string
  /** 实例名称 */
  instanceName: string
  /** 游戏版本 */
  gameVersion: string
  /**
   * 实际写入实例的版本 id。
   *
   * 原版安装与 `gameVersion` 相同；加载器安装是加载器生成的版本 id
   * （例如 `fabric-loader-0.16.10-1.21.1`），旧记录没有该字段。
   */
  versionId?: string
  /** 加载器（原版为空） */
  loader?: { kind: LoaderKind; version: string }
  /** 任务 id；终态安装归档后会清空，统计改看 stats */
  taskIds: string[]
  createdAt: number
  state?: InstallJobState
  /** 准备阶段失败或被取消的原因 */
  error?: string
  /**
   * 准备阶段的当前步骤（例如「下载 Forge 安装器 42%」）。
   *
   * 加载器安装要先下载安装器再运行它，这一步可能持续几十秒到几分钟；没有这个
   * 字段时界面只能显示「正在准备下载清单」，看起来像卡死。就绪后清空。
   */
  note?: string
  /**
   * 准备阶段的整体进度（0–100）。
   *
   * 准备阶段还没有文件级任务，`stats.percent` 是 0；下载页用这个值填总进度条，
   * 让「下安装器 / 取依赖库」也计入同一根进度条。就绪后清空。
   */
  preparePercent?: number
  /** 安装方式；旧记录没有该字段，按 install 处理 */
  mode?: InstallMode
  /** 终态汇总；任务明细被清理后，下载页仍能显示历史统计 */
  stats?: InstallJobStats
}

/**
 * 下载页的一行。
 *
 * 一次安装可能有几千个文件级任务，页面只需要聚合结果；逐文件明细留给
 * 需要时再按安装 id 查询，避免首屏搬运几十 MB 数据。
 */
export interface InstallJobSummary {
  id: string
  instanceName: string
  gameVersion: string
  loader?: { kind: LoaderKind; version: string }
  mode?: InstallMode
  state: InstallJobState
  error?: string
  /** 准备阶段的当前步骤；与 InstallJob.note 同源 */
  note?: string
  /** 准备阶段的整体进度（0–100）；与 InstallJob.preparePercent 同源 */
  preparePercent?: number
  createdAt: number
  /** 准备阶段之外、已经没有进行中的文件时为 true */
  finished: boolean
  stats: InstallJobStats
}

/** 安装请求：下载页面 -> 主进程 */
export interface InstallRequest {
  gameVersion: string
  instanceName: string
  loader?: { kind: LoaderKind; version: string }
}

/** 补全请求：启动页对已有实例发起，只下载缺失文件 */
export interface InstallRepairRequest {
  /** 实例目录名 */
  instanceName: string
  /** 实例当前使用的版本 id */
  versionId: string
}

/**
 * 安装任务的实时阶段，由下载管线按任务状态汇总。
 * 启动页据此显示「下载中 / 已暂停 / 不完整」。
 */
export type InstallLiveState =
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'done'
  | 'cancelled'

export interface InstanceInstallStatus {
  /** 实例目录名 */
  instanceName: string
  jobId: string
  state: InstallLiveState
  /** 有可重试的失败任务；否则补全时应该新建 repair 任务 */
  retryable: boolean
}

/**
 * 安装受理结果。
 *
 * 主进程受理后立即返回，下载清单在后台准备；成功时 `error` 为空，
 * 进度统一在下载页查看，调用方不需要（也不应该）展示 jobId。
 */
export interface InstallStartResult {
  jobId: string
  error?: string
}

/** 下载源：一个可排序的镜像条目 */
export interface DownloadSource {
  label: string
  /** 替换 launchermeta.mojang.com */
  launchermeta: string
  /** 替换 libraries.minecraft.net */
  libraries: string
  /** 替换 resources.download.minecraft.net */
  resources: string
  /** 是否参与下载；关闭后该源被跳过 */
  enabled: boolean
}

/** 默认下载源（顺序即优先级） */
export const DEFAULT_DOWNLOAD_SOURCES: ReadonlyArray<DownloadSource> = [
  {
    label: 'Mojang 官方',
    launchermeta: 'launchermeta.mojang.com',
    libraries: 'libraries.minecraft.net',
    resources: 'resources.download.minecraft.net',
    enabled: true,
  },
  {
    label: 'BMCLAPI 镜像',
    launchermeta: 'bmclapi2.bangbang93.com',
    libraries: 'bmclapi2.bangbang93.com/maven',
    resources: 'bmclapi2.bangbang93.com/assets',
    enabled: true,
  },
]

/**
 * 把持久化/外部来源的下载源数据归一化成当前契约。
 *
 * 旧版本保存的条目没有 `enabled` 字段，这里统一补成开启；
 * 传入非数组时退回默认源。
 */
export function normalizeDownloadSources(value: unknown): DownloadSource[] {
  if (!Array.isArray(value)) return DEFAULT_DOWNLOAD_SOURCES.map((source) => ({ ...source }))
  const sources: DownloadSource[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    sources.push({
      label: typeof record.label === 'string' ? record.label : '',
      launchermeta: typeof record.launchermeta === 'string' ? record.launchermeta : '',
      libraries: typeof record.libraries === 'string' ? record.libraries : '',
      resources: typeof record.resources === 'string' ? record.resources : '',
      enabled: record.enabled !== false,
    })
  }
  return sources
}

/**
 * 模组加载器下载源：一个镜像通常只覆盖一种加载器，因此条目带 `kind`。
 *
 * 与原版下载源一样按列表顺序决定优先级：同一加载器可以有多个源，
 * 前一个失败时自动尝试下一个。
 */
export interface LoaderSource {
  label: string
  /** 该源提供的加载器类型 */
  kind: LoaderSourceKind
  /** 元数据根地址：版本清单、安装档案 */
  meta: string
  /** 文件根地址：加载器库、安装器 */
  maven: string
  /** 是否参与下载；关闭后该源被跳过 */
  enabled: boolean
}

/** 默认加载器下载源：官方地址优先，BMCLAPI 作为国内镜像兜底 */
export const DEFAULT_LOADER_SOURCES: ReadonlyArray<LoaderSource> = [
  {
    label: 'Fabric 官方',
    kind: 'fabric',
    meta: 'meta.fabricmc.net',
    maven: 'maven.fabricmc.net',
    enabled: true,
  },
  {
    label: 'Forge 官方',
    kind: 'forge',
    meta: 'files.minecraftforge.net',
    maven: 'maven.minecraftforge.net',
    enabled: true,
  },
  {
    label: 'NeoForge 官方',
    kind: 'neoforge',
    // 版本接口在站点根路径 /api 下；文件仍在 /releases
    meta: 'maven.neoforged.net',
    maven: 'maven.neoforged.net/releases',
    enabled: true,
  },
  {
    label: 'Fabric BMCLAPI',
    kind: 'fabric',
    meta: 'bmclapi2.bangbang93.com/fabric-meta',
    maven: 'bmclapi2.bangbang93.com/maven',
    enabled: true,
  },
  {
    label: 'Forge BMCLAPI',
    kind: 'forge',
    meta: 'bmclapi2.bangbang93.com/forge',
    maven: 'bmclapi2.bangbang93.com/maven',
    enabled: true,
  },
  {
    label: 'NeoForge BMCLAPI',
    kind: 'neoforge',
    meta: 'bmclapi2.bangbang93.com',
    maven: 'bmclapi2.bangbang93.com/maven',
    enabled: true,
  },
]

/**
 * 把持久化/外部来源的加载器下载源归一化成当前契约。
 *
 * 未知加载器类型的条目会被丢弃（旧版本或手工编辑的数据可能包含它们）；
 * 地址留空表示使用该加载器的官方地址，旧条目没有 `enabled` 时补成开启。
 */
export function normalizeLoaderSources(value: unknown): LoaderSource[] {
  if (!Array.isArray(value)) return DEFAULT_LOADER_SOURCES.map((source) => ({ ...source }))
  const sources: LoaderSource[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (!isLoaderSourceKind(record.kind)) continue
    const official = DEFAULT_LOADER_SOURCES.find((source) => source.kind === record.kind)
    const meta = typeof record.meta === 'string' ? record.meta.trim() : ''
    const maven = typeof record.maven === 'string' ? record.maven.trim() : ''
    sources.push({
      label: typeof record.label === 'string' ? record.label : '',
      kind: record.kind,
      meta: meta || official?.meta || '',
      maven: maven || official?.maven || '',
      enabled: record.enabled !== false,
    })
  }
  return sources
}

/** 最大并发下载文件的默认值 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = '64'

/** 下载缓存上限（GB）的默认值 */
export const DEFAULT_DOWNLOAD_CACHE_LIMIT = '5'

/** 下载管线持久化设置 */
export interface DownloadSettings {
  concurrency: string
  cacheLimit: string
  sources: DownloadSource[]
  loaderSources: LoaderSource[]
}
