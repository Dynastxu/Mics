import type { DownloadEndpoint } from './download-pipeline'
import type { LoaderSource, LoaderSourceKind, LoaderVersion } from './download'
import type { VersionDetail } from './minecraft'
import type { Disposable } from './services'

/**
 * 加载器安装的跨插件契约。
 *
 * 每个加载器是一个独立插件：自己拥有镜像配置、版本列表与安装方式；
 * 安装过程中需要的文件下载与 Java 进程由 `LoaderRuntime` 提供，加载器插件
 * 不直接碰下载队列，也不直接读实例状态。
 */

export interface LoaderVersionQuery {
  kind: LoaderSourceKind
  gameVersion: string
  signal?: AbortSignal
}

export interface LoaderJavaSpec {
  args: string[]
  cwd: string
  logFile: string
  requiredMajor: number
}

export interface LoaderRuntime {
  /** 通过下载管线取一个文件；带镜像回退 */
  download(
    url: string,
    target: string,
    sha1?: string,
    size?: number,
    options?: {
      reportProgress?: boolean
      direct?: boolean
      /** 调用方显式指定的候选源（例如原版客户端 jar 的镜像） */
      sources?: DownloadEndpoint[]
    }
  ): Promise<void>
  /** 运行 Java 进程并等待退出；取消时结束进程 */
  runJava(spec: LoaderJavaSpec): Promise<void>
  /** 准备阶段的步骤与百分比；下载页据此显示进度 */
  report(note: string, percent?: number): void
  log(level: 'info' | 'warn', message: string): void
}

export interface LoaderPrepareInput {
  /** 管线任务 id：安装器与依赖库都下载到同一个任务里 */
  jobId: string
  kind: LoaderSourceKind
  gameVersion: string
  loaderVersion: string
  /** 实例根目录 */
  instanceDir: string
  /** 共享库目录：安装器产出的库最终并入这里 */
  librariesDir: string
  /** 原版版本文件（已取到的父版本信息） */
  parent: VersionDetail
  /** 原版客户端 jar 的候选源（安装器需要它，必须走原版镜像） */
  clientSources?: DownloadEndpoint[]
  signal: AbortSignal
}

export interface LoaderPrepareResult {
  /** 加载器版本文件里的版本 id，也是实例里的版本档案名 */
  versionId: string
  /** 加载器版本文件（可能带 inheritsFrom，由调用方合并父版本） */
  version: VersionDetail
  /**
   * profile：文件都还没下载，按合并后的清单全量下载；
   * installer：安装器已经把文件放进实例，只补齐缺失项。
   */
  mode: 'profile' | 'installer'
  /**
   * 加载器库地址的候选源。
   *
   * 版本档案里的库通常指向官方 maven；调用方在生成下载清单时用它换成
   * 该加载器配置的镜像。不是加载器地址时返回空数组，调用方继续用原版源。
   */
  sourcesFor?: (url: string) => DownloadEndpoint[]
}

export interface LoaderProvider {
  readonly kind: LoaderSourceKind
  /** 该加载器自己的镜像配置（可增删、排序、启停） */
  sources(): LoaderSource[]
  setSources(sources: LoaderSource[]): void
  listVersions(gameVersion: string, signal: AbortSignal): Promise<LoaderVersion[]>
  prepare(input: LoaderPrepareInput, runtime: LoaderRuntime): Promise<LoaderPrepareResult>
}

/** `mics.download.loaders` 提供的注册表 */
export interface LoadersServiceApi {
  register(provider: LoaderProvider): Disposable
  get(kind: LoaderSourceKind): LoaderProvider | undefined
  list(): LoaderProvider[]
}
