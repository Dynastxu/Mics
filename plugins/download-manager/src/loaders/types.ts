import type { LoaderSource, LoaderSourceKind, LoaderVersion } from '@mics/sdk'
import type { VersionDetail } from '../version'

/**
 * 加载器提供方接口。
 *
 * 每种加载器只负责回答两件事：有哪些版本、怎么把文件准备到实例目录；
 * 下载队列、进度、校验、缓存都由下载管线统一处理。新增加载器只需要
 * 实现这个接口并在 registry 里登记（OCP）。
 */
export interface LoaderEnvironment {
  readonly signal: AbortSignal
  /** 该加载器参与下载的源，已按优先级排序 */
  readonly sources: LoaderSource[]
  /** 请求该加载器元数据源上的 JSON；`path` 拼在源基址之后 */
  fetchJson<T>(path: string, role?: 'meta' | 'maven'): Promise<T>
  fetchText(path: string, role?: 'meta' | 'maven'): Promise<string>
  /** 直接请求一个绝对地址（加载器自有 API 用，例如 NeoForge 的 /api） */
  fetchJsonUrl<T>(url: string): Promise<T>
  /** 下载一个必需文件（多源回退），不进入任务队列 */
  download(url: string, target: string, sha1?: string, size?: number, options?: DownloadOptions): Promise<void>
  /** 运行 Java 进程（安装器）；取消时结束进程 */
  runJava(spec: {
    args: string[]
    cwd: string
    logFile: string
    requiredMajor: number
  }): Promise<void>
  log(level: 'info' | 'warn', message: string): void
  /** 准备阶段的进度文本与当前步骤的百分比（0–100），供下载页显示 */
  report?(note: string, percent?: number): void
}

export interface DownloadOptions {
  /**
   * 是否把字节级进度拼到当前步骤后面。
   *
   * 批量预取依赖库时关掉：调用方用「已取 N/M 个」汇报整体进度，单个文件的
   * 百分比只会让提示来回跳。
   */
  reportProgress?: boolean
}

export interface LoaderInstallInput {
  gameVersion: string
  loaderVersion: string
  /** 实例根目录 */
  instanceDir: string
  /** 共享库目录：安装器产出的库最终并入这里 */
  librariesDir: string
  /** 原版版本文件（已下载的父版本信息） */
  parent: VersionDetail
}

export interface LoaderInstallPlan {
  /** 加载器版本文件里的版本 id，也是实例版本目录名 */
  versionId: string
  /** 加载器版本文件（可能带 inheritsFrom，由下载管线合并父版本） */
  version: VersionDetail
  /**
   * profile：文件都还没下载，按合并后的清单全量下载；
   * installer：安装器已经把文件放进实例，只补齐缺失项。
   */
  mode: 'profile' | 'installer'
}

export interface LoaderProvider {
  readonly kind: LoaderSourceKind
  listVersions(gameVersion: string, env: LoaderEnvironment): Promise<LoaderVersion[]>
  install(input: LoaderInstallInput, env: LoaderEnvironment): Promise<LoaderInstallPlan>
}
