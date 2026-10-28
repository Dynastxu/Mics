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
export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'

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
 * - `failed` / `cancelled`：终态，`error` 说明原因
 *
 * 旧版本持久化的任务没有该字段，读取时按 `ready` 处理。
 */
export type InstallJobState = 'preparing' | 'ready' | 'failed' | 'cancelled'

/** 一组关联的下载任务（一次安装操作） */
export interface InstallJob {
  id: string
  /** 实例名称 */
  instanceName: string
  /** 游戏版本 */
  gameVersion: string
  /** 加载器（原版为空） */
  loader?: { kind: LoaderKind; version: string }
  /** 总体进度 */
  taskIds: string[]
  createdAt: number
  state?: InstallJobState
  /** 准备阶段失败或被取消的原因 */
  error?: string
}

/** 安装请求：下载页面 -> 主进程 */
export interface InstallRequest {
  gameVersion: string
  instanceName: string
  loader?: { kind: LoaderKind; version: string }
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

/** 最大并发下载文件的默认值 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = '64'

/** 下载缓存上限（GB）的默认值 */
export const DEFAULT_DOWNLOAD_CACHE_LIMIT = '5'

/** 下载管线持久化设置 */
export interface DownloadSettings {
  concurrency: string
  cacheDir: string
  cacheLimit: string
  sources: DownloadSource[]
}
