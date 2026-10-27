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
}

/** 安装请求：下载页面 -> 主进程 */
export interface InstallRequest {
  gameVersion: string
  instanceName: string
  loader?: { kind: LoaderKind; version: string }
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
}

/** 默认下载源（顺序即优先级） */
export const DEFAULT_DOWNLOAD_SOURCES: ReadonlyArray<DownloadSource> = [
  {
    label: 'Mojang 官方',
    launchermeta: 'launchermeta.mojang.com',
    libraries: 'libraries.minecraft.net',
    resources: 'resources.download.minecraft.net',
  },
  {
    label: 'BMCLAPI 镜像',
    launchermeta: 'bmclapi2.bangbang93.com',
    libraries: 'bmclapi2.bangbang93.com/maven',
    resources: 'bmclapi2.bangbang93.com/assets',
  },
]

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
