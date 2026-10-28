import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Command, CommandInfo, Disposable, PluginId } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'

interface Registered {
  command: Command
  owner?: PluginId
}

/**
 * 命令服务。命令既可以由清单声明（未激活也可见），
 * 也可以由插件在激活时注册实现；执行时若尚未注册，
 * 会先按清单找到归属插件并触发激活。
 */
export class CommandsService extends Service {
  static inject = ['plugins']

  private readonly owner: Context
  private readonly registry = new Map<string, Registered>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
    this.owner = ctx
  }

  register(command: Command): Disposable {
    if (this.registry.has(command.id)) {
      throw new Error(`命令 ${command.id} 已被注册`)
    }
    const owner = pluginIdOf(this.ctx)
    this.registry.set(command.id, { command, owner })
    return this.ctx.effect(() => () => {
      this.registry.delete(command.id)
    })
  }

  has(id: string): boolean {
    return this.registry.has(id) || Boolean(this.declaredOwner(id))
  }

  list(): CommandInfo[] {
    const result = new Map<string, CommandInfo>()
    for (const info of this.owner.plugins.list()) {
      // 禁用的插件视同未安装：它的清单命令不出现在命令面板里
      if (info.state === 'disabled') continue
      for (const command of info.manifest.contributes?.commands ?? []) {
        result.set(command.id, {
          id: command.id,
          title: command.title,
          category: command.category,
          keybinding: command.keybinding,
          pluginId: info.id,
        })
      }
    }
    for (const [id, entry] of this.registry) {
      const declared = result.get(id)
      result.set(id, {
        id,
        title: entry.command.title ?? declared?.title ?? id,
        category: entry.command.category ?? declared?.category,
        keybinding: entry.command.keybinding ?? declared?.keybinding,
        pluginId: entry.owner ?? declared?.pluginId,
      })
    }
    return [...result.values()]
  }

  async execute<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    let entry = this.registry.get(id)
    if (!entry) {
      const owner = this.declaredOwner(id)
      if (owner) {
        await this.owner.plugins.activate(owner)
        entry = this.registry.get(id)
      }
    }
    if (!entry) throw new Error(`未找到命令 ${id}`)
    return (await entry.command.handler(...args)) as T
  }

  private declaredOwner(id: string): PluginId | undefined {
    for (const info of this.owner.plugins.list()) {
      if (info.state === 'disabled') continue
      if (info.manifest.contributes?.commands?.some((command) => command.id === id)) {
        return info.id
      }
    }
    return undefined
  }
}
