import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { addressOf, ServerStatusService } from './status'
import { readServerStatusSettings } from './settings'
import { ServerStore } from './servers'
import type { ServerInput, ServerStatusQuery } from './shared'

export const name = 'mics.server-status'
export const inject = ['ipc', 'storage']

function idsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return ids.length > 0 ? ids : undefined
}

/**
 * 服务器状态（主进程）。
 *
 * 只暴露一组只读 / 增删的 RPC，网络查询全部放在主进程：
 *
 * - 页面只拿可序列化的结果，换页、重挂载都不会重新发请求（主进程有缓存）；
 * - mcstatus.io 的限流与缓存逻辑只有这一份，多窗口也不会各自打满额度；
 * - `node-mcstatus` 是 Node 库，渲染进程本来也拿不到 `require`。
 *
 * 列表与设置都落在插件存储里：本地列表没有 JSON Schema 可表达，设置则同时
 * 声明在清单的 `contributes.configuration` 里，设置页可以直接改。
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)
  const store = new ServerStore(ctx.storage)
  const status = new ServerStatusService(() => readServerStatusSettings(ctx.storage), log)

  /** 列表：添加 / 删除之后也返回整份列表，页面只维护一个状态 */
  ctx.ipc.handle('servers/list', () => store.list())

  ctx.ipc.handle<ServerInput>('servers/add', (input) => {
    const entry = store.add(input ?? {})
    log.info('已添加服务器：%s（%s）', entry.label, addressOf(entry))
    return store.list()
  })

  ctx.ipc.handle<{ id?: unknown }>('servers/remove', (input) => {
    const entry = store.remove(input?.id)
    status.forget(entry.id)
    log.info('已删除服务器：%s（%s）', entry.label, addressOf(entry))
    return store.list()
  })

  /** 查询状态：`ids` 缺省时查全部，`force` 跳过缓存（手动刷新用） */
  ctx.ipc.handle<ServerStatusQuery>('servers/status', async (request) => {
    const ids = idsOf(request?.ids)
    const servers = store.list()
    const targets = ids ? servers.filter((server) => ids.includes(server.id)) : servers
    return status.query(targets, request?.force === true)
  })

  /** 页面自带的设置视图只需要刷新间隔与接口地址；写入统一走 configuration/set */
  ctx.ipc.handle('settings/read', () => readServerStatusSettings(ctx.storage))

  const servers = store.list()
  log.info(
    '服务器状态就绪：%d 台服务器，接口 %s',
    servers.length,
    readServerStatusSettings(ctx.storage).apiBaseUrl
  )
}

export default defineMainPlugin({ name, inject, apply })
