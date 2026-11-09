import type { LoaderSourceKind } from './download'
import type { DownloadEndpoint } from './download-pipeline'
import type { VersionDetail } from './minecraft'

/**
 * 原版游戏安装的跨插件契约。
 *
 * `mics.download.game` 拥有 Mojang 元数据、实例目录与 `install-state.json`；
 * 其它插件（原版页、整合包）通过事件请求它准备版本、生成文件清单与收尾，
 * 不自己写实例状态文件。
 */

export interface GamePrepareInput {
  /** 管线任务 id：加载器安装器与依赖库下载都归属这个任务 */
  jobId: string
  gameVersion: string
  loader?: { kind: LoaderSourceKind; version: string }
  /** 实例根目录 */
  instanceDir: string
  signal?: AbortSignal
}

export interface GamePrepareResult {
  /** 实际写入实例的版本 id（加载器安装时与游戏版本不同） */
  versionId: string
  /** 已合并父版本、id 已改写的自包含版本档案 */
  version: VersionDetail
  /** profile：按清单全量下载；installer：安装器已落盘，只补缺失项 */
  mode: 'profile' | 'installer'
  loader?: { kind: LoaderSourceKind; version: string }
  /** 加载器库地址的候选源；原版文件继续用原版源 */
  sourcesFor?: (url: string) => DownloadEndpoint[]
}

export interface GameCollectInput {
  version: VersionDetail
  versionId: string
  /** 实例根目录 */
  instanceDir: string
  /** 补全模式：只返回缺失的文件 */
  onlyMissing?: boolean
  /** 加载器库地址的候选源（由 `game/prepareVersion` 返回） */
  sourcesFor?: (url: string) => DownloadEndpoint[]
  signal?: AbortSignal
}

export interface GameBeginInstall {
  jobId: string
  instanceName: string
}

export interface GameCompleteInstall {
  jobId: string
  instanceName: string
  versionId: string
}

export interface GameDiscardInstall {
  jobId: string
  instanceName: string
}
