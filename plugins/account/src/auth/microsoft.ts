import { formatUuid } from '../model'
import {
  HttpRequestError,
  formBody,
  jsonBody,
  requestJson,
  numberField,
  recordOf,
  stringField,
} from './http'

/**
 * Microsoft 账户登录（设备码流程）。
 *
 * 流程与官方启动器一致：
 *   设备码 → MSA access token → Xbox Live → XSTS → Minecraft access token → 玩家档案
 *
 * TODO(account): 当前默认 client id 是临时占位——官方启动器的 Live 应用 id，
 * 授权页会显示 Minecraft Launcher。正式发布前注册名为 `Mics` 的 Azure 应用，
 * 把「插件管理 → 账户」里的 client id 换成该应用的 GUID 即可自动切到 Entra 端点，
 * 不需要改代码。注册步骤见 README「账户与启动」。
 *
 * 两套端点按 client id 形态自动选择：
 *   - Live 应用 id（数字串，例如官方启动器的 id）→ login.live.com；
 *   - Azure 应用 id（GUID）→ login.microsoftonline.com/consumers。
 *
 * 只保存 refresh token：每次启动都重新换一遍 Minecraft 令牌，避免把一个会过期
 * 的 access token 存到磁盘上再担心它什么时候失效。
 */

export type MicrosoftAuthority = 'live' | 'entra'

const AUTHORITIES: Record<MicrosoftAuthority, { deviceCode: string; token: string }> = {
  live: {
    deviceCode: 'https://login.live.com/oauth20_connect.srf',
    token: 'https://login.live.com/oauth20_token.srf',
  },
  entra: {
    deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  },
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Azure 应用 id 是 GUID，Live 应用 id 是数字串；据此决定设备码端点 */
export function authorityOf(clientId: string): MicrosoftAuthority {
  return GUID_PATTERN.test(clientId.trim()) ? 'entra' : 'live'
}

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'
const SCOPE = 'XboxLive.signin offline_access'

/** 设备码流程的终态错误（过期 / 被拒绝）；网络错误不会用这个类型，轮询可以继续 */
export class DeviceLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceLoginError'
  }
}

/** 保存的 refresh token 已失效，需要用户重新登录 */
export class MicrosoftTokenExpiredError extends Error {
  constructor() {
    super('Microsoft refresh token 已失效')
    this.name = 'MicrosoftTokenExpiredError'
  }
}

/** XSTS 的 XErr 值 -> 可以直接展示给用户的说明 */
const XSTS_ERRORS: Record<number, string> = {
  2148916227: '该账户已被 Xbox Live 封禁',
  2148916233: '该 Microsoft 账户还没有 Xbox 档案，请先在 xbox.com 创建',
  2148916235: '该账户所在地区不支持 Xbox Live',
  2148916236: '该账户需要在 xbox.com 完成成人验证',
  2148916237: '该账户需要在 xbox.com 完成成人验证',
  2148916238: '未成年账户需要先加入 Microsoft 家庭组',
}

export interface DeviceCodeInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** 设备码过期时间戳 */
  expiresAt: number
  /** 建议轮询间隔（秒） */
  interval: number
}

export interface MicrosoftTokens {
  accessToken: string
  refreshToken: string
}

export interface MinecraftIdentity {
  /** Minecraft services 的 access token */
  accessToken: string
  /** 带连字符的 UUID */
  uuid: string
  name: string
}

export class MicrosoftAuth {
  constructor(private readonly clientId: () => string) {}

  /** 是否已配置 Azure 应用；账户页据此提示先填 client id */
  configured(): boolean {
    return this.clientId().trim().length > 0
  }

  private requireClientId(): string {
    const id = this.clientId().trim()
    if (!id) {
      throw new Error('正版登录尚未配置：请在「插件管理 → 账户」填写以 Mics 注册的 Azure 应用 client id')
    }
    return id
  }

  async startDeviceCode(): Promise<DeviceCodeInfo> {
    const clientId = this.requireClientId()
    const authority = authorityOf(clientId)
    const data = await requestJson<Record<string, unknown>>(AUTHORITIES[authority].deviceCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({
        client_id: clientId,
        scope: SCOPE,
        // Live 的设备码端点要求显式声明 response_type；Entra 会忽略它
        ...(authority === 'live' ? { response_type: 'device_code' } : {}),
      }),
    })
    const deviceCode = stringField(data, 'device_code')
    const userCode = stringField(data, 'user_code')
    const verificationUri = stringField(data, 'verification_uri')
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error('Microsoft 登录响应缺少 device_code / user_code / verification_uri')
    }
    const expiresIn = numberField(data, 'expires_in') ?? 900
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: Date.now() + expiresIn * 1000,
      interval: Math.max(3, numberField(data, 'interval') ?? 5),
    }
  }

  /** 轮询一次；仍在等待用户在浏览器里授权时返回 null */
  async pollDeviceCode(deviceCode: string): Promise<MicrosoftTokens | null> {
    const clientId = this.requireClientId()
    try {
      const data = await requestJson<Record<string, unknown>>(
        AUTHORITIES[authorityOf(clientId)].token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody({
            client_id: clientId,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
          }),
        },
      )
      return tokensOf(data)
    } catch (cause) {
      if (cause instanceof HttpRequestError) {
        if (cause.code === 'authorization_pending' || cause.code === 'slow_down') return null
        if (cause.code === 'expired_token') throw new DeviceLoginError('登录码已过期，请重新开始')
        if (cause.code === 'authorization_declined' || cause.code === 'access_denied') {
          throw new DeviceLoginError('登录已在浏览器中被取消')
        }
      }
      throw cause
    }
  }

  async refresh(refreshToken: string): Promise<MicrosoftTokens> {
    const clientId = this.requireClientId()
    const authority = authorityOf(clientId)
    let data: Record<string, unknown>
    try {
      data = await requestJson<Record<string, unknown>>(AUTHORITIES[authority].token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          // Entra 的 refresh 需要 scope；Live 端点带不带都可以
          ...(authority === 'entra' ? { scope: SCOPE } : {}),
        }),
      })
    } catch (cause) {
      // 只有明确被拒绝才算「需要重新登录」；网络故障留给调用方按失败重试
      if (cause instanceof HttpRequestError && cause.code === 'invalid_grant') {
        throw new MicrosoftTokenExpiredError()
      }
      throw cause
    }
    return tokensOf(data)
  }

  /** 用 MSA access token 换 Minecraft 令牌与玩家档案 */
  async credentials(msaAccessToken: string): Promise<MinecraftIdentity> {
    const xbl = await requestJson<Record<string, unknown>>(XBL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${msaAccessToken}`,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      }),
    })
    const xblToken = stringField(xbl, 'Token')
    if (!xblToken) throw new Error('Xbox Live 认证没有返回令牌')

    let xsts: Record<string, unknown>
    try {
      xsts = await requestJson<Record<string, unknown>>(XSTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody({
          Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
          RelyingParty: 'rp://api.minecraftservices.com/',
          TokenType: 'JWT',
        }),
      })
    } catch (cause) {
      const xerr = cause instanceof HttpRequestError ? numberField(cause.data, 'XErr') : undefined
      if (xerr !== undefined) {
        throw new Error(XSTS_ERRORS[xerr] ?? `Xbox Live 拒绝了登录（XErr ${xerr}）`)
      }
      throw cause
    }

    const xstsToken = stringField(xsts, 'Token')
    const claims = recordOf(recordOf(xsts).DisplayClaims)
    const xui = Array.isArray(claims.xui) ? claims.xui[0] : undefined
    const userHash = stringField(xui, 'uhs')
    if (!xstsToken || !userHash) throw new Error('Xbox Live 认证没有返回用户标识')

    const minecraft = await requestJson<Record<string, unknown>>(MINECRAFT_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` }),
    })
    const accessToken = stringField(minecraft, 'access_token')
    if (!accessToken) throw new Error('Minecraft 服务没有返回 access token')

    let profile: Record<string, unknown>
    try {
      profile = await requestJson<Record<string, unknown>>(MINECRAFT_PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    } catch (cause) {
      if (cause instanceof HttpRequestError && cause.status === 404) {
        throw new Error('该 Microsoft 账户没有 Minecraft: Java Edition 的购买记录')
      }
      throw cause
    }

    const uuid = formatUuid(profile.id)
    const name = stringField(profile, 'name')
    if (!uuid || !name) throw new Error('Minecraft 档案缺少 UUID 或玩家名')
    return { accessToken, uuid, name }
  }
}

function tokensOf(data: unknown): MicrosoftTokens {
  const accessToken = stringField(data, 'access_token')
  const refreshToken = stringField(data, 'refresh_token')
  if (!accessToken) throw new Error('Microsoft 登录响应缺少 access_token')
  if (!refreshToken) throw new Error('Microsoft 登录响应缺少 refresh_token')
  return { accessToken, refreshToken }
}
