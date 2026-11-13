import type { Context } from 'cordis'
import type { CapabilityProviderInfo } from './capability'
import type { CatalogFileRef, CatalogResolvedFile } from './catalog'
import type {
  GameVersion,
  InstallRepairRequest,
  InstallRequest,
  InstallStartResult,
  LoaderVersion
} from './download'
import type {
  DownloadAddFilesRequest,
  DownloadAddFilesResult,
  DownloadAwaitRequest,
  DownloadDataRequest,
  DownloadFileRequest,
  DownloadFileResult,
  DownloadFinishRequest,
  DownloadJobHandle,
  DownloadJobRequest,
  DownloadJobResult,
  DownloadJobSnapshot,
  DownloadPlacement,
  DownloadPlacementResult,
  DownloadReportPatch,
  DownloadRetryResult,
  LegacyDownloadConfig
} from './download-pipeline'
import type {
  GameBeginInstall,
  GameCollectInput,
  GameCompleteInstall,
  GameDiscardInstall,
  GamePrepareInput,
  GamePrepareResult
} from './game'
import type { InstanceNameCheck, ModRemoval } from './instance'
import type { LoaderPrepareInput, LoaderPrepareResult, LoaderVersionQuery } from './loader'
import type { LogEntry } from './logs'
import type { PluginId } from './manifest'
import type { ModProjectKind, ModSourceKind } from './mod'
import type { NotificationOptions } from './notifications'
import type { RpcRequest, RpcResponse } from './runtime'

/**
 * cordis 4 的五种事件派发模式。
 *
 * 选错模式不会报错，只会让语义变得靠猜，因此每个事件都在
 * `MicsEvents` 上写明模式，并由 `EVENT_MODES` 统一登记：
 *
 * | 模式 | 语义 | 适用 |
 * | --- | --- | --- |
 * | `emit` | 通知，同步执行，返回值丢弃 | 状态变化、观察点 |
 * | `parallel` | 扇出，等全部完成，失败聚合成 AggregateError | 互不依赖的收尾工作 |
 * | `serial` | 串行，遇到第一个结论即停止 | 需要异步判断的审批 |
 * | `bail` | 同步投票，第一个非空返回值即结论 | 同步决策（主题选择、同步审批） |
 * | `waterfall` | 中间件，监听器拿到 `next()`，可短路或改写 | 执行路径拦截（IPC、命令） |
 *
 * 派发方一律使用本文件导出的 `emitEvent` / `bailEvent` / `waterfallEvent`
 * 等辅助函数：事件名与模式对不上时是编译错误，而不是运行期才发现的约定问题。
 */
export type EventDispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

/**
 * 插件激活审批结论。
 *
 * 监听器返回 `undefined` 表示「不表态」；第一个返回结论的监听器生效。
 * 因此审批插件应当用 `ctx.on(name, fn, true)`（prepend）注册，
 * 让拒绝结论先于放行结论。
 */
export interface PluginActivationVerdict {
  allow: boolean
  /** 拒绝原因；会进入插件失败态与诊断信息 */
  reason?: string
}

/**
 * 目录项目的展示文案。
 *
 * Mod / 整合包 / 资源包 / 光影包 / 数据包共用同一种摘要，`id` 是
 * `${source}:${projectId}` 的跨来源稳定键；`name` 与 `summary` 是来源返回的
 * 原文，翻译插件只能改写这份展示副本，不能反向影响缓存、搜索或指纹识别。
 */
export interface CatalogDescriptor {
  kind: ModProjectKind
  id: string
  source: ModSourceKind
  projectId: string
  slug: string
  name: string
  summary: string
}

/**
 * Mics 对 cordis 的事件扩展。
 *
 * 与 cordis 自带的 `internal/*` 事件分开维护，`EVENT_MODES` 只覆盖这里声明的事件；
 * 新增事件时表与接口一起改，漏写模式会直接编译失败。
 */
export interface MicsEvents {
  /** 通知：插件集合或任一插件状态变化。 */
  'plugins/changed'(): void

  /** 通知：插件真正进入 active（服务依赖满足、apply 执行完毕）。 */
  'plugin/activated'(id: PluginId): void

  /** 通知：插件被停用、卸载或失败。 */
  'plugin/deactivated'(id: PluginId): void

  /**
   * 审批：激活一个插件之前询问所有插件。
   *
   * 同步投票（`bail`）：返回 `{ allow: false, reason }` 即拒绝，返回
   * `undefined` 表示不表态。需要异步审批时请挂在 `ipc/before`。
   */
  'plugin/beforeActivate'(id: PluginId): PluginActivationVerdict | void

  /**
   * RPC 派发前的中间件链（`waterfall`）。
   *
   * 每个监听器拿到请求和 `next()`：返回 `next()` 继续、返回 `RpcResponse`
   * 短路。权限、审计、限流、二次确认都挂在这里，内核不再为每条策略加 if。
   */
  'ipc/before'(request: RpcRequest, next: () => Promise<RpcResponse>): Promise<RpcResponse>

  /** RPC 派发后的观察点（`emit`）；只做同步记录，异步工作请自行排队。 */
  'ipc/after'(request: RpcRequest, response: RpcResponse): void

  /** 通知：某能力的提供方发生变化（新增、撤销、被更高优先级顶替）。 */
  'capability/changed'(name: string, providers: CapabilityProviderInfo[]): void

  /**
   * 通知：请求显示一条界面通知。
   *
   * 由 `mics.notifications` 订阅；插件被禁用时没有订阅者，事件自然丢弃，
   * 调用方不依赖通知插件的生命周期。
   */
  'notification/show'(options: NotificationOptions | string): void

  /** 通知：导航切换到指定页面；插件可在页面重新可见时刷新数据。 */
  'ui/viewActivated'(viewId: string): void

  /**
   * 改写目录项目的名称/描述（`waterfall`）。
   *
   * 派发点在主进程的目录 RPC 边界，缓存仍然保存来源原文：监听器只拿到一份
   * 展示副本，返回改写后的副本即可，未命中时原样返回 `next()`。监听器必须
   * 调用 `next()`，否则后面的监听器不会执行；抛出的异常由派发方吞掉并回退原文。
   */
  'catalog/describe'(
    descriptor: CatalogDescriptor,
    next: () => Promise<CatalogDescriptor>
  ): Promise<CatalogDescriptor>

  /**
   * 内核产生的一条日志（`emit`）。
   *
   * 日志插件只订阅这个事件，不碰 cordis 的内部缓冲区、也不需要 `electron`：
   * 它就是一个「收事件、写文件」的观察者。
   */
  'log/entry'(entry: LogEntry): void

  /** 启动阶段的历史日志（`emit`），在启动插件激活完成后派发一次 */
  'log/history'(entries: LogEntry[]): void

  // -------------------------------------------------------------------------
  // 下载管线（`mics.download.manager`）
  // -------------------------------------------------------------------------

  /**
   * 创建一次下载任务（`serial`）。
   *
   * 管线只登记任务；文件清单随后用 `download/addFiles` 分批提交，因此
   * 「先下安装器、运行后再生成游戏文件清单」这类分阶段安装不需要特殊接口。
   */
  'download/create'(request: DownloadJobRequest): Promise<DownloadJobHandle> | void

  /** 向任务追加一批文件（`serial`）；可多次调用，返回本批 task id。 */
  'download/addFiles'(request: DownloadAddFilesRequest): Promise<DownloadAddFilesResult> | void

  /**
   * 改写一批文件的目标（`waterfall`）。
   *
   * 管线在登记任务之前派发它（`download/addFiles` 内部）：此时还没有任何字节
   * 落盘，监听器可以给同名文件让路，返回新的 `savePath`。数组必须等长、下标
   * 对应；监听器抛出的异常由管线吞掉并回退原清单，第三方插件不能阻断下载。
   */
  'download/targets'(
    files: DownloadFileRequest[],
    next: () => Promise<DownloadFileRequest[]>
  ): Promise<DownloadFileRequest[]>

  /**
   * 等待指定文件进入终态（`serial`）。
   *
   * 用于阶段依赖：加载器插件必须等安装器下载完才能运行 Java。
   */
  'download/awaitFiles'(request: DownloadAwaitRequest): Promise<DownloadFileResult[]> | void

  /**
   * 编排方收尾（`serial`）：全部文件完成（或失败）后由创建者调用。
   *
   * 管线在文件全部完成时先置 `finalizing` 并发 `download/filesDone`，
   * 编排方写完 ready 标记 / 合并覆盖文件后再调用这里。
   */
  'download/finish'(request: DownloadFinishRequest): Promise<void> | void

  /** 更新编排方私有状态（`serial`）；管线原样持久化。 */
  'download/data'(request: DownloadDataRequest): Promise<void> | void

  /**
   * 封口（`serial`）：编排方已经提交完全部文件。
   *
   * 分阶段安装会先提交「安装器」、等它完成后再提交游戏文件；封口之前即使
   * 当前这一批文件全部完成，管线也不能宣布整个任务完成。
   */
  'download/seal'(jobId: string): Promise<void> | void

  /**
   * 重试（`serial`）。
   *
   * 管线先尝试重排失败任务并返回 `true`；没有可重排的任务时返回 `false`，
   * 由创建该任务的编排方重新分析（例如准备阶段失败）。
   */
  'download/retry'(jobId: string): Promise<DownloadRetryResult> | void

  /** 准备阶段的上报（`emit`）：步骤、当前步骤百分比、单文件字节。 */
  'download/report'(jobId: string, patch: DownloadReportPatch): void

  /** 任务已受理（`emit`）。 */
  'download/started'(jobId: string): void

  /** 单个文件结束（`emit`）；编排方可以据此清理安装器等临时文件。 */
  'download/fileFinished'(jobId: string, file: DownloadFileResult): void

  /**
   * 一批文件全部进入终态且没有失败（`emit`）。
   *
   * 编排方在这里做收尾；收尾完成后必须调用 `download/finish`。
   */
  'download/filesDone'(jobId: string): void

  /** 任务进入终态（`emit`）：done / failed / cancelled。 */
  'download/jobFinished'(jobId: string, result: DownloadJobResult): void

  /** 应用启动后恢复了一个未完成任务（`emit`）；编排方重新挂上监听。 */
  'download/jobResumed'(jobId: string, job: DownloadJobSnapshot): void

  /** 任务记录被删除（`emit`）；编排方清理自己的暂存目录。 */
  'download/discarded'(jobId: string): void

  /** 旧版下载插件保存的源配置（`serial`，只读）；各插件启动时导入一次。 */
  'download/legacy-config'(): Promise<LegacyDownloadConfig> | void

  /**
   * 自定义文件的落盘方式（`waterfall`）。
   *
   * 文件已写到 `savePath` 并通过校验。监听器可以把实体搬进内容库、只在原
   * 位置留一条硬链接，并返回最终落点；默认实现什么都不做。管线按返回值继续
   * 写下载缓存与取消清理。不经过管线、直接往实例落文件的编排方（整合包覆盖
   * 文件）也派发同一事件，让内容库同样接管。
   */
  'download/commit'(
    placement: DownloadPlacement,
    next: () => Promise<DownloadPlacementResult>
  ): Promise<DownloadPlacementResult>

  /**
   * 通知：实例里删除了一个 Mod 文件（`emit`）。
   *
   * 删除只移除实例目录里的那一条链接，实体可能仍被其它实例引用；
   * 内容库插件据此回收没有引用的实体。
   */
  'mods/removed'(removed: ModRemoval): void

  // -------------------------------------------------------------------------
  // 原版游戏（`mics.download.game`）
  // -------------------------------------------------------------------------

  /** 原版版本列表（`serial`）。 */
  'game/versions'(): Promise<GameVersion[]> | void

  /** 校验实例名（纯规则 + 目录占用）（`serial`）。 */
  'game/validateName'(request: { name: string }): Promise<InstanceNameCheck> | void

  /** 取父版本、安装加载器并写出自包含版本档案（`serial`）。 */
  'game/prepareVersion'(request: GamePrepareInput): Promise<GamePrepareResult> | void

  /** 把版本档案展开成下载清单（`serial`）。 */
  'game/collectFiles'(request: GameCollectInput): Promise<DownloadFileRequest[]> | void

  /** 写入 installing 状态并占住实例名（`serial`）。 */
  'game/beginInstall'(request: GameBeginInstall): Promise<void> | void

  /** 写入 ready 状态（`serial`）；只有全部文件与收尾都完成才调用。 */
  'game/completeInstall'(request: GameCompleteInstall): Promise<void> | void

  /** 取消安装时删除半成品实例（`serial`）。 */
  'game/discardInstall'(request: GameDiscardInstall): Promise<void> | void

  /** 受理一次新实例安装（`serial`）。 */
  'game/install'(request: InstallRequest): Promise<InstallStartResult> | void

  /** 受理一次补全（`serial`）。 */
  'game/repair'(request: InstallRepairRequest): Promise<InstallStartResult> | void

  // -------------------------------------------------------------------------
  // 加载器（`mics.download.loader.*`，由 `mics.download.loaders` 路由）
  // -------------------------------------------------------------------------

  /** 某个加载器在指定游戏版本下的可用版本（`serial`）。 */
  'loader/versions'(request: LoaderVersionQuery): Promise<LoaderVersion[]> | void

  /** 准备一个加载器安装（`serial`）；由对应 kind 的插件处理。 */
  'loader/prepare'(request: LoaderPrepareInput): Promise<LoaderPrepareResult> | void

  // -------------------------------------------------------------------------
  // 社区目录（`mics.download.catalog`）
  // -------------------------------------------------------------------------

  /**
   * 把 CurseForge 整合包清单的数字 id 解析成可下载文件（`serial`）。
   *
   * 只有 CurseForge 来源插件知道自己的 API；整合包插件不直接调来源接口。
   */
  'catalog/resolveModpackFiles'(request: {
    refs: CatalogFileRef[]
    sourceApi?: string
  }): Promise<CatalogResolvedFile[]> | void
}

/**
 * 每个 Mics 事件的派发模式。
 *
 * `satisfies Record<keyof MicsEvents, …>` 保证：新增事件却忘了登记模式时
 * 编译失败，读者也不需要翻派发点猜语义。
 */
export const EVENT_MODES = {
  'plugins/changed': 'emit',
  'plugin/activated': 'emit',
  'plugin/deactivated': 'emit',
  'plugin/beforeActivate': 'bail',
  'ipc/before': 'waterfall',
  'ipc/after': 'emit',
  'capability/changed': 'emit',
  'notification/show': 'emit',
  'ui/viewActivated': 'emit',
  'catalog/describe': 'waterfall',
  'log/entry': 'emit',
  'log/history': 'emit',
  'download/create': 'serial',
  'download/addFiles': 'serial',
  'download/targets': 'waterfall',
  'download/awaitFiles': 'serial',
  'download/finish': 'serial',
  'download/data': 'serial',
  'download/seal': 'serial',
  'download/retry': 'serial',
  'download/report': 'emit',
  'download/started': 'emit',
  'download/fileFinished': 'emit',
  'download/filesDone': 'emit',
  'download/jobFinished': 'emit',
  'download/jobResumed': 'emit',
  'download/discarded': 'emit',
  'download/legacy-config': 'serial',
  'download/commit': 'waterfall',
  'mods/removed': 'emit',
  'game/versions': 'serial',
  'game/validateName': 'serial',
  'game/prepareVersion': 'serial',
  'game/collectFiles': 'serial',
  'game/beginInstall': 'serial',
  'game/completeInstall': 'serial',
  'game/discardInstall': 'serial',
  'game/install': 'serial',
  'game/repair': 'serial',
  'loader/versions': 'serial',
  'loader/prepare': 'serial',
  'catalog/resolveModpackFiles': 'serial'
} as const satisfies Record<keyof MicsEvents, EventDispatchMode>

export type MicsEventName = keyof MicsEvents

/** 某个派发模式允许的事件名；用来把「事件名 + 模式」写进函数签名 */
export type EventInMode<M extends EventDispatchMode> = {
  [K in MicsEventName]: (typeof EVENT_MODES)[K] extends M ? K : never
}[MicsEventName]

type Args<K extends MicsEventName> = Parameters<MicsEvents[K]>

/** 通知（`emit`）：只表达「发生了什么」，没有返回值，也不会等待。 */
export function emitEvent<K extends EventInMode<'emit'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): void {
  ctx.emit(name, ...args)
}

/** 同步投票（`bail`）：第一个返回非空值的监听器给出结论。 */
export function bailEvent<K extends EventInMode<'bail'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): ReturnType<MicsEvents[K]> {
  return ctx.bail(name, ...args) as ReturnType<MicsEvents[K]>
}

/** 中间件（`waterfall`）：监听器通过 `next()` 决定是否继续。 */
export function waterfallEvent<K extends EventInMode<'waterfall'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): ReturnType<MicsEvents[K]> {
  return ctx.waterfall(name, ...args) as ReturnType<MicsEvents[K]>
}

/** 串行处理（`serial`）：逐个等待监听器，遇到第一个结论即停止。 */
export async function serialEvent<K extends EventInMode<'serial'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): Promise<Awaited<ReturnType<MicsEvents[K]>>> {
  return (await ctx.serial(name, ...args)) as Awaited<ReturnType<MicsEvents[K]>>
}

/** 扇出（`parallel`）：等全部监听器完成，不读取返回值。 */
export async function parallelEvent<K extends EventInMode<'parallel'>>(
  ctx: Context,
  name: K,
  ...args: Args<K>
): Promise<void> {
  await ctx.parallel(name, ...args)
}

declare module 'cordis' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Events extends MicsEvents {}
}
