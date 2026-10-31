import type { ModFileRef, ModSourceKind } from './mod'

/**
 * 整合包安装。
 *
 * 整合包与 Mod 的区别在于「安装会新建一个实例」而不是往已有实例里塞文件：
 * 主进程需要先下载并解析整合包归档，确定游戏版本、加载器与文件清单，再走
 * 与原版安装相同的下载管线。页面只提供归档地址和实例名。
 */
export interface ModpackInstallRequest {
  /** 新实例名；主进程会再次校验重名与非法字符 */
  instanceName: string
  /** 整合包展示名（用于下载页标题） */
  title?: string
  /** 整合包版本号（用于下载页副标题） */
  version?: string
  /** 整合包归档（.mrpack / .zip） */
  file: ModFileRef
  /** 归档来源；CurseForge 整合包需要据此选择带 API Key 的下载源 */
  source: ModSourceKind
  /** 命中来源的接口地址；多镜像时用于锁定具体来源 */
  sourceApi?: string
}

/** 整合包安装记录里需要跨阶段保留的信息 */
export interface ModpackInstallMeta {
  /** 整合包展示名 */
  name: string
  /** 整合包版本号 */
  version: string
  /**
   * 解压后的覆盖文件暂存目录（实例内绝对路径）。
   *
   * 覆盖文件必须等整合包内所有 Mod 下载完成后再合并，否则会被同名文件覆盖；
   * 完成安装时由下载管线合并进实例并删除。
   */
  overridesDir?: string
}
