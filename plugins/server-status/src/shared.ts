/**
 * 主进程与页面共用的类型与常量。
 *
 * 这里只放可序列化的数据：值会经 IPC 信封在两侧之间传递，不能带类实例、
 * 函数或 `AbortSignal`。构建时两侧各自打包，因此常量也只有这一份来源。
 */

/** 服务器版本；对应 mcstatus.io 的 /status/java 与 /status/bedrock 两条路由 */
export type ServerEdition = 'java' | 'bedrock'

/** 列表里的一台服务器；删除与查询都按 `id` 寻址 */
export interface ServerEntry {
  id: string
  /** 不带端口的主机名；端口由 node-mcstatus 拼进请求地址 */
  host: string
  port: number
  edition: ServerEdition
  /** 显示名；缺省是地址 */
  label: string
}

/** 在线人数；服务端没有返回时整个对象为 null */
export interface ServerPlayers {
  online: number
  max: number
}

/** 一次状态查询的结果；失败也走这个形状，用 `error` 区分「离线」与「没查成」 */
export interface ServerStatus {
  id: string
  online: boolean
  players: ServerPlayers | null
  /** 版本名（已去掉格式化字符）；拿不到时为空串 */
  version: string
  /** MOTD 的纯文本行：不渲染服务端给的 HTML */
  motd: string[]
  /** 服务端图标（data URI）；只有 Java 版可能带 */
  icon: string | null
  /** 服务端报告的状态时间（Unix 毫秒），不是本次请求的时间 */
  retrievedAt: number
  /** 查询过程本身的错误（接口不可用、限流、地址无法解析）；为空表示接口返回了结果 */
  error: string
}

/** 插件设置；默认值同时写在 plugin.json 的 configuration 里 */
export interface ServerStatusSettings {
  apiBaseUrl: string
  refreshSeconds: number
}

/** `servers/add` 的入参：地址也接受 `host:port` 写法 */
export interface ServerInput {
  address?: unknown
  label?: unknown
  edition?: unknown
}

/** `servers/status` 的入参；`ids` 缺省时查列表里的全部服务器 */
export interface ServerStatusQuery {
  ids?: unknown
  force?: unknown
}

/** `settings/read` 返回的设置默认值（配置 schema 之外再兜一层） */
export const DEFAULT_SETTINGS: ServerStatusSettings = {
  apiBaseUrl: 'https://api.mcstatus.io/v2',
  refreshSeconds: 60
}

/** 自动刷新间隔的下限；mcstatus.io 按 IP 限制 5 次/秒，更密没有意义 */
export const MIN_REFRESH_SECONDS = 15

/** 插件 id：渲染端激活主进程半边、发 RPC 都用它 */
export const PLUGIN_ID = 'mics.server-status'

/** 页面视图 id，与清单 `contributes.nav[].id` 一致 */
export const VIEW_ID = 'server-status'
