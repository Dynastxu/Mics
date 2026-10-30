import path from 'node:path'

/**
 * 实例磁盘布局解析（Node 侧，只给主进程插件用）。
 *
 * 用户数据根下有一个 `.minecraft`，它就是原版启动器里那个「启动器目录 + 游戏根」：
 *
 * - `<userData>/.minecraft/versions/<实例名>`：一个实例，同时是版本目录与游戏目录
 * - `<userData>/.minecraft/libraries`：maven 坐标寻址的库，所有实例共用
 * - `<userData>/.minecraft/assets`：`indexes` + `objects`，所有实例共用
 *
 * 一个实例只有一次安装、一个加载器，所以实例目录本身就是版本目录：版本 json、
 * 客户端 jar、`natives`、`mods`、`saves` 全在同一层，相当于 PCL 开启版本隔离后的
 * `versions/<版本>` 目录，只是名字换成了实例名。
 *
 * 应用自己的 `plugins` / `logs` / `profiles` / `cache` 留在用户数据根，与游戏数据
 * 分开：`.minecraft` 可以整目录搬走或备份，不影响启动器的元数据。
 *
 * 调用方**不要自己拼这些路径**，启动与下载两边都必须经这里解析，否则会写出两套目录。
 */

/** 游戏根目录名（用户数据根下），结构对齐原版启动器 */
export const GAME_ROOT_DIR = '.minecraft'
/** 库目录名（游戏根下） */
export const LIBRARIES_DIR = 'libraries'
/** 资源目录名（游戏根下），内含 `indexes` 与 `objects` */
export const ASSETS_DIR = 'assets'
/**
 * 实例容器目录名（游戏根下）。
 *
 * 与 PCL 的 `.minecraft/versions/<版本>` 对齐：容器名沿用 `versions`，但里面装的是
 * **实例**目录，且实例目录内部不再按版本 id 分层（一实例一版本）。
 */
export const INSTANCES_DIR = 'versions'
/** 实例目录下的本地库目录名 */
export const NATIVES_DIR = 'natives'
/** 实例目录下的日志配置目录名 */
export const LOG_CONFIGS_DIR = 'log_configs'

export interface InstanceLayout {
  /** 实例目录：同时是游戏目录与版本目录 */
  instanceDir: string
  /** 存放 maven 风格库文件的目录（跨实例共享） */
  librariesDir: string
  /** 存放 `indexes` / `objects` 的资源目录（跨实例共享） */
  assetsDir: string
  /** 解压后的本地库目录 */
  nativesDir: string
  /** 日志配置目录 */
  logConfigsDir: string
}

/** 游戏根目录：`<userData>/.minecraft` */
export function gameRoot(userDataDir: string): string {
  return path.join(userDataDir, GAME_ROOT_DIR)
}

/** 共享库目录：`<userData>/.minecraft/libraries` */
export function sharedLibrariesDir(userDataDir: string): string {
  return path.join(gameRoot(userDataDir), LIBRARIES_DIR)
}

/** 实例容器目录：`<userData>/.minecraft/versions` */
export function instancesRoot(userDataDir: string): string {
  return path.join(gameRoot(userDataDir), INSTANCES_DIR)
}

/** 共享资源目录：`<userData>/.minecraft/assets` */
export function sharedAssetsDir(userDataDir: string): string {
  return path.join(gameRoot(userDataDir), ASSETS_DIR)
}

/** 版本档案：`<实例>/<版本 id>.json` */
export function instanceVersionJson(instanceDir: string, versionId: string): string {
  return path.join(instanceDir, `${versionId}.json`)
}

/** 客户端 jar：`<实例>/<版本 id>.jar` */
export function instanceClientJar(instanceDir: string, versionId: string): string {
  return path.join(instanceDir, `${versionId}.jar`)
}

/** 解析一个实例的资源位置；只做路径组装，不碰文件系统 */
export function resolveInstanceLayout(userDataDir: string, instanceDir: string): InstanceLayout {
  return {
    instanceDir,
    librariesDir: sharedLibrariesDir(userDataDir),
    assetsDir: sharedAssetsDir(userDataDir),
    nativesDir: path.join(instanceDir, NATIVES_DIR),
    logConfigsDir: path.join(instanceDir, LOG_CONFIGS_DIR),
  }
}
