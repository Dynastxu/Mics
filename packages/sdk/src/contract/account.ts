/**
 * 账户与启动凭据契约。
 *
 * 账户本体属于 `mics.account` 插件；其它插件只依赖这里的抽象：
 * - 渲染进程读 `AccountSummary` 做选择、经账户插件的 RPC 增删；
 * - 主进程用 `AUTH_CREDENTIALS` 能力换取启动凭据，不需要知道登录方式。
 *
 * 这样不同登录方式的差异（目前是 Microsoft 正版与离线）全部留在账户插件里，
 * 启动管线只拿一份与版本档案对应的凭据（名字、UUID、令牌、user_type）。
 * 将来的第三方登录（Yggdrasil / authlib-injector）只需要在账户插件里再加一个
 * provider，启动管线与这里的接口都不用改。
 */

export type AccountKind = 'microsoft' | 'offline'

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  microsoft: '正版',
  offline: '离线',
}

/** 渲染进程展示 / 选择账户需要的字段；令牌之类不跨进程外传 */
export interface AccountSummary {
  id: string
  kind: AccountKind
  /** 游戏内玩家名：离线为手填名，正版为档案名 */
  name: string
  /** 带连字符的 UUID */
  uuid: string
  createdAt: number
  /** false 表示令牌已失效，需要在账户页重新登录 */
  authorized: boolean
}

/** 账户列表与当前选中账户 */
export interface AccountSnapshot {
  accounts: AccountSummary[]
  activeId: string | null
}

/** 版本档案里 `${user_type}` 的取值 */
export type GameUserType = 'legacy' | 'mojang' | 'msa'

/**
 * 一次启动所需的账户凭据。
 *
 * `jvmArgs` 由账户插件提供（第三方登录要注入 authlib-injector 之类的 agent），
 * 启动管线只负责原样拼进 JVM 参数，不判断账户类型。
 */
export interface LaunchCredentials {
  accountId: string
  name: string
  uuid: string
  accessToken: string
  userType: GameUserType
  jvmArgs?: string[]
}

/** 账户提供方实现：启动插件唯一依赖的账户接口 */
export const AUTH_CREDENTIALS = 'mics.account.credentials'

export interface AuthCredentialsCapability {
  readonly label: string
  /** 解析账户的启动凭据；省略 accountId 时使用当前选中的账户 */
  resolve(accountId?: string): Promise<LaunchCredentials>
}

/** 账户列表、当前账户或授权状态变化；payload 为 AccountSnapshot */
export const ACCOUNT_CHANGED_TOPIC = 'mics.account/changed'
