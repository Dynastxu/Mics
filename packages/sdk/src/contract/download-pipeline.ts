/**
 * 下载管线的跨插件契约。
 * 管线只接收「哪些内容、从哪些源下载」：目标路径、摘要、大小与候选地址都由
 * 调用方（原版 / 加载器 / 社区 / 整合包 / 资源包插件）解析好。管线不解析
 * Mojang 版本、不认加载器、不认 Modrinth / CurseForge，也不碰实例状态。
 *
 * 请求通过 `serial` 事件派发，完成情况通过 `emit` 事件发布：
 *
 *   create → addFiles（可多批）→ awaitFiles（按需）→ filesDone → finish
 *
 * 任务失败、取消、重试与暂停都由管线自己处理；编排方只负责准备阶段与收尾。
 */

import type { DownloadSource, LoaderSource } from './download'
import type { ModSource } from './mod'

/** 一个候选下载地址：调用方从自己的镜像配置里解析好，管线按顺序尝试 */
export interface DownloadEndpoint {
  /** 健康度键，例如 'mojang:0' / 'bmclapi:1' / 'direct' */
  id: string
  label: string
  url: string
  /** 仅用于健康度分组；不影响下载行为 */
  category?: 'meta' | 'library' | 'asset' | 'loader' | 'file' | (string & {})
}

/** 一个待下载文件 */
export interface DownloadFileRequest {
  label: string
  /** 规范地址：缓存键与日志使用；没有 sources 时它就是唯一下载地址 */
  url: string
  savePath: string
  /** 空字符串表示跳过摘要校验 */
  sha1?: string
  size?: number
  /** 从哪些源下载；按顺序回退，省略表示直链 */
  sources?: DownloadEndpoint[]
  /** 多个源竞速：同时请求，谁先完成用谁（安装器、客户端等大文件用） */
  race?: boolean
  /** 下载开始前目标目录必须仍然存在（实例 / 存档被删时不要复活它） */
  guardDir?: string
}

/** 创建一次下载任务（一次安装 / 一次批量下载） */
export interface DownloadJobRequest {
  title: string
  detail?: string
  /** 不透明标签：管线只用于展示与 install/status 分组 */
  kind: string
  /** 归属实例；进度页与启动页用它关联实例 */
  scope?: { instanceName?: string }
  /** 编排方私有状态（例如 overrides 暂存目录），管线原样持久化、不解释 */
  data?: unknown
  /**
   * 文件全部完成即结算（不需要编排方收尾）。
   *
   * Mod / 资源包这类「只落盘、不写实例状态」的任务设为 true；管线在文件完成时
   * 直接置 done，重启后重试也能自行收尾。
   */
  autoFinish?: boolean
  /** 只用于下载页展示的附加字段；管线不解释，也不参与任何决策 */
  display?: {
    packKind?: string
    gameVersion?: string
    loader?: { kind: string; version: string }
    mode?: string
  }
}

export interface DownloadJobHandle {
  jobId: string
}

export interface DownloadAddFilesRequest {
  jobId: string
  files: DownloadFileRequest[]
}

export interface DownloadAddFilesResult {
  taskIds: string[]
}

export interface DownloadAwaitRequest {
  jobId: string
  taskIds: string[]
}

export interface DownloadFileResult {
  taskId: string
  state: 'done' | 'failed'
  error?: string
}

export interface DownloadReportPatch {
  /** 准备阶段的当前步骤 */
  note?: string
  /** 准备阶段当前步骤的百分比；不传表示这一步不可度量 */
  percent?: number
  /** 准备阶段单文件传输的进度（例如整合包归档） */
  loaded?: number
  total?: number
  /** 准备阶段累计从网络收到的字节增量 */
  bytes?: number
}

export type DownloadJobState =
  'preparing' | 'downloading' | 'finalizing' | 'done' | 'failed' | 'cancelled'

/** 一次任务的聚合进度；下载页只依赖这份汇总 */
export interface DownloadStats {
  total: number
  waiting: number
  paused: number
  downloading: number
  done: number
  failed: number
  /** failed 中由取消产生的数量 */
  cancelled: number
  loaded: number
  bytes: number
  /** 真正走网络的字节；缓存 / 共享文件复用不计入 */
  transferred: number
  /** 0–100 */
  percent: number
}

/** 管线对外暴露的任务快照；`data` 给编排方自己解释 */
export interface DownloadJobSnapshot {
  id: string
  kind: string
  title: string
  detail?: string
  scope?: { instanceName?: string }
  data?: unknown
  display?: {
    packKind?: string
    gameVersion?: string
    loader?: { kind: string; version: string }
    mode?: string
  }
  state: DownloadJobState
  note?: string
  preparePercent?: number
  prepareLoaded?: number
  prepareTotal?: number
  prepareTransferAt?: number
  taskIds: string[]
  createdAt: number
  error?: string
}

export interface DownloadJobResult {
  jobId: string
  state: Extract<DownloadJobState, 'done' | 'failed' | 'cancelled'>
  error?: string
  stats: DownloadStats
}

/** 下载页展开详情里的一行 */
export interface DownloadTaskView {
  id: string
  label: string
  state: import('./download').DownloadTaskState
  loaded: number
  /** -1 表示未知 */
  total: number
  size: number
  error?: string
}

/** 编排方收尾：全部文件完成（或失败）后由创建者调用 */
export interface DownloadFinishRequest {
  jobId: string
  state: 'done' | 'failed'
  error?: string
}

/** 更新编排方私有状态（例如版本 id、overrides 暂存目录）；管线原样保存 */
export interface DownloadDataRequest {
  jobId: string
  data: unknown
}

/** 管线自己重试失败任务成功时返回 true；false 表示交给编排方重新分析 */
export type DownloadRetryResult = boolean

/**
 * 旧版下载插件保存的源配置。
 *
 * 拆分后配置归各自插件所有，但用户已填的镜像 / API Key 不能丢：
 * 新插件启动时读取一次并写入自己的存储。
 */
export interface LegacyDownloadConfig {
  sources?: DownloadSource[]
  loaderSources?: LoaderSource[]
  modSources?: ModSource[]
}
