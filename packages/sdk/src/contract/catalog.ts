import type {
  ModCategory,
  ModFileRef,
  ModIdentifyFile,
  ModIdentity,
  ModProjectKind,
  ModProjectRequest,
  ModSearchRequest,
  ModSearchResult,
  ModSource,
  ModSourceInfo,
  ModSourceKind,
  ModSummary,
  ModVersion,
  ModVersionRequest
} from './mod'
import type { Disposable } from './services'

/**
 * 社区目录的跨插件契约。
 *
 * 每个社区来源（Modrinth / CurseForge）是一个独立插件：自己拥有接口地址、
 * API Key、分类映射与文件解析。`mics.download.catalog` 只做注册、合并、分页、
 * 缓存与 `catalog/describe`，不认识任何来源字段。
 */

/** CurseForge 整合包清单里的一条文件引用 */
export interface CatalogFileRef {
  projectId: number
  fileId: number
  required: boolean
}

export interface CatalogResolvedFile {
  entry: CatalogFileRef
  file: ModFileRef
}

/**
 * 作者关闭了第三方分发、只能手动下载的文件。
 *
 * 来源插件仍然能给出文件名、摘要与文件页：安装方据此列出待办清单，
 * 用户从文件页下载后由安装方按摘要校验并继续。
 */
export interface CatalogBlockedFile {
  entry: CatalogFileRef
  fileName: string
  sha1: string
  size: number
  /** 文件页；来源拿不到页面时为空串 */
  pageUrl: string
  /** 项目展示名，便于清单里辨认；解析不到时为空串 */
  projectName: string
}

/** 一次整合包文件解析的结果：能自动下载的与只能手动下载的分开返回 */
export interface CatalogResolvedModpack {
  files: CatalogResolvedFile[]
  blocked: CatalogBlockedFile[]
}

export interface CatalogSource {
  readonly kind: ModSourceKind
  /** 该来源自己的镜像 / 接口条目（可多条，按顺序） */
  sources(): ModSource[]
  setSources(sources: ModSource[]): void
  /** 至少有一个启用的条目可用（例如 CurseForge 已填 Key） */
  ready(): boolean
  info(): ModSourceInfo
  categories(kind: ModProjectKind): ModCategory[]
  search(
    request: ModSearchRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModSearchResult>
  versions(
    request: ModVersionRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModVersion[]>
  project(
    request: ModProjectRequest,
    kind: ModProjectKind,
    signal: AbortSignal
  ): Promise<ModSummary>
  identify(files: ModIdentifyFile[], signal: AbortSignal): Promise<ModIdentity[]>
  /** 把 CurseForge 整合包清单的数字 id 解析成可下载文件与待手动下载文件 */
  resolveModpackFiles(
    refs: CatalogFileRef[],
    signal: AbortSignal,
    onProgress?: (done: number, total: number) => void
  ): Promise<CatalogResolvedModpack>
}

/** `mics.download.catalog` 提供的注册表 */
export interface CatalogRegistry {
  register(source: CatalogSource): Disposable
  list(): CatalogSource[]
  get(kind: ModSourceKind): CatalogSource | undefined
}
