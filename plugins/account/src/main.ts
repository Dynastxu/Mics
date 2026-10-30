import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import type {
  AccountSnapshot,
  AccountSummary,
  AuthCredentialsCapability,
  LaunchCredentials,
} from '@mics/sdk'
import { ACCOUNT_CHANGED_TOPIC, AUTH_CREDENTIALS } from '@mics/sdk'
import {
  DeviceLoginError,
  MicrosoftAuth,
  MicrosoftTokenExpiredError,
  type MinecraftIdentity,
} from './auth/microsoft'
import {
  messageOf,
  newAccountId,
  offlineUuid,
  sanitizePlayerName,
  toSummary,
  type StoredAccount,
} from './model'
import { seal, unseal } from './secrets'
import type { DeviceLoginPoll, DeviceLoginStart } from './shared'
import { AccountStore } from './store'

export const name = 'mics.account'
export const inject = ['ipc', 'storage', 'capabilities']

/** 一次进行中的 Microsoft 设备码登录 */
interface DeviceFlow {
  deviceCode: string
  expiresAt: number
  /** 重新登录已有正版账户时带上它的 id */
  replaceId?: string
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.account')

  let store: AccountStore
  const broadcast = (): void => {
    ctx.ipc.broadcast(ACCOUNT_CHANGED_TOPIC, store.snapshot(), name)
  }
  store = new AccountStore(ctx.storage, broadcast)

  const microsoft = new MicrosoftAuth(() =>
    String(ctx.storage.get('microsoftClientId', '') ?? ''),
  )
  const flows = new Map<string, DeviceFlow>()
  ctx.effect(() => () => flows.clear())

  /** 同一身份（kind + uuid）只保留一条记录 */
  function findDuplicate(kind: StoredAccount['kind'], uuid: string): StoredAccount | undefined {
    return store.list().find((account) => account.kind === kind && account.uuid === uuid)
  }

  /** 令牌失效时记一次状态，界面据此提示「需要重新登录」 */
  function markUnauthorized(account: StoredAccount): void {
    if (account.authorized === false) return
    store.update(account.id, { authorized: false })
    log.warn('账户 %s 的令牌已失效，需要重新登录', account.name)
  }

  function pruneFlows(): void {
    const now = Date.now()
    for (const [id, flow] of flows) {
      if (now > flow.expiresAt) flows.delete(id)
    }
  }

  function saveMicrosoft(
    replaceId: string | undefined,
    identity: MinecraftIdentity,
    refreshToken: string,
  ): StoredAccount {
    const secrets = { refreshToken: seal(refreshToken) }
    const target = replaceId ? store.get(replaceId) : undefined
    if (target) {
      if (target.kind !== 'microsoft') throw new Error('该账户不是正版账户')
      return store.update(target.id, {
        name: identity.name,
        uuid: identity.uuid,
        authorized: true,
        secrets,
      })
    }
    const existing = findDuplicate('microsoft', identity.uuid)
    if (existing) {
      return store.update(existing.id, { name: identity.name, authorized: true, secrets })
    }
    return store.add({
      id: newAccountId(),
      kind: 'microsoft',
      name: identity.name,
      uuid: identity.uuid,
      createdAt: Date.now(),
      authorized: true,
      secrets,
    })
  }

  ctx.ipc.handle('accounts/list', (): AccountSnapshot => store.snapshot())

  /** 正版登录是否已配置 Azure 应用；账户页据此在登录前给出提示 */
  ctx.ipc.handle('accounts/config', () => ({ microsoftConfigured: microsoft.configured() }))

  ctx.ipc.handle<{ name?: string }>('accounts/offline', (params): AccountSummary => {
    const playerName = sanitizePlayerName(params?.name)
    const uuid = offlineUuid(playerName)
    const existing = findDuplicate('offline', uuid)
    const account = existing
      ? store.update(existing.id, { name: playerName, authorized: true })
      : store.add({
          id: newAccountId(),
          kind: 'offline',
          name: playerName,
          uuid,
          createdAt: Date.now(),
          authorized: true,
        })
    store.setActive(account.id)
    log.info('离线账户已保存：%s', playerName)
    return toSummary(account)
  })

  ctx.ipc.handle<{ replaceId?: string }>('accounts/login/start', async (params): Promise<DeviceLoginStart> => {
    const replaceId = params?.replaceId
    if (replaceId && !store.get(replaceId)) throw new Error('要重新登录的账户不存在')
    pruneFlows()

    const info = await microsoft.startDeviceCode()
    const flowId = randomUUID()
    flows.set(flowId, {
      deviceCode: info.deviceCode,
      expiresAt: info.expiresAt,
      ...(replaceId ? { replaceId } : {}),
    })
    // 不自动打开浏览器：由界面展示验证码，用户点「复制并跳转至登录」再打开
    log.info('Microsoft 登录已开始，验证码 %s', info.userCode)
    return {
      flowId,
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      expiresAt: info.expiresAt,
      interval: info.interval,
    }
  })

  ctx.ipc.handle<{ flowId?: string }>('accounts/login/poll', async (params): Promise<DeviceLoginPoll> => {
    const flowId = params?.flowId
    if (!flowId) throw new Error('缺少登录流程 id')
    const flow = flows.get(flowId)
    if (!flow) return { status: 'error', error: '登录流程已结束，请重新开始' }
    if (Date.now() > flow.expiresAt) {
      flows.delete(flowId)
      return { status: 'error', error: '登录码已过期，请重新开始' }
    }

    let tokens
    try {
      tokens = await microsoft.pollDeviceCode(flow.deviceCode)
    } catch (cause) {
      if (cause instanceof DeviceLoginError) {
        flows.delete(flowId)
        log.warn('Microsoft 登录失败：%s', cause.message)
        return { status: 'error', error: cause.message }
      }
      // 网络抖动不能作废设备码：保留流程，下一次轮询继续
      log.warn('Microsoft 登录轮询失败，稍后重试：%s', messageOf(cause))
      return { status: 'pending' }
    }
    if (!tokens) return { status: 'pending' }

    try {
      const identity = await microsoft.credentials(tokens.accessToken)
      const account = saveMicrosoft(flow.replaceId, identity, tokens.refreshToken)
      flows.delete(flowId)
      store.setActive(account.id)
      log.info('Microsoft 登录成功：%s', account.name)
      return { status: 'done', account: toSummary(account) }
    } catch (cause) {
      flows.delete(flowId)
      log.warn('Microsoft 登录失败：%s', messageOf(cause))
      return { status: 'error', error: messageOf(cause) }
    }
  })

  ctx.ipc.handle<{ flowId?: string }>('accounts/login/cancel', (params) => {
    if (params?.flowId) flows.delete(params.flowId)
  })

  ctx.ipc.handle<{ id?: string }>('accounts/setActive', (params): AccountSnapshot => {
    if (!params?.id) throw new Error('缺少账户 id')
    store.setActive(params.id)
    return store.snapshot()
  })

  ctx.ipc.handle<{ id?: string }>('accounts/remove', (params): AccountSnapshot => {
    if (!params?.id) throw new Error('缺少账户 id')
    const account = store.get(params.id)
    if (!account) return store.snapshot()
    store.remove(account.id)
    log.info('账户已移除：%s', account.name)
    return store.snapshot()
  })

  /**
   * 启动凭据。
   *
   * 每次启动都重新换一遍正版令牌：用 refresh token 走完 MSA → Xbox → Minecraft，
   * 避免把会过期的 access token 存到磁盘上。令牌失效会标记账户并把原因抛给界面，
   * 由用户决定是否重新登录。
   */
  async function credentialsOf(accountId?: string): Promise<LaunchCredentials> {
    const account = accountId ? store.get(accountId) : store.activeAccount()
    if (!account) {
      throw new Error(accountId ? '账户不存在，请重新选择' : '还没有添加账户，请先在「账户」页添加')
    }

    switch (account.kind) {
      case 'offline':
        return {
          accountId: account.id,
          name: account.name,
          uuid: account.uuid,
          accessToken: '0',
          userType: 'legacy',
        }

      case 'microsoft': {
        const refreshToken = unseal(account.secrets?.refreshToken)
        if (!refreshToken) {
          markUnauthorized(account)
          throw new Error(`账户「${account.name}」需要重新登录`)
        }

        let tokens
        try {
          tokens = await microsoft.refresh(refreshToken)
        } catch (cause) {
          if (cause instanceof MicrosoftTokenExpiredError) {
            markUnauthorized(account)
            throw new Error('Microsoft 登录已失效，请在账户页重新登录')
          }
          throw new Error(`无法连接 Microsoft 登录服务：${messageOf(cause)}`)
        }

        let identity: MinecraftIdentity
        try {
          identity = await microsoft.credentials(tokens.accessToken)
        } catch (cause) {
          throw new Error(`无法获取 Minecraft 档案：${messageOf(cause)}`)
        }

        store.update(account.id, {
          name: identity.name,
          uuid: identity.uuid,
          authorized: true,
          secrets: { ...account.secrets, refreshToken: seal(tokens.refreshToken) },
        })
        return {
          accountId: account.id,
          name: identity.name,
          uuid: identity.uuid,
          accessToken: identity.accessToken,
          userType: 'msa',
        }
      }
    }
  }

  ctx.capabilities.provide<AuthCredentialsCapability>(AUTH_CREDENTIALS, {
    label: 'mics.account',
    resolve: (accountId) => credentialsOf(accountId),
  })

  log.info('账户服务已就绪：%d 个账户', store.list().length)
}

export default defineMainPlugin({ name, inject, apply })
