import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Command, CommandInfo, Disposable } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'
import { isDeclaredCommand, store } from '../store'

/**
 * 渲染进程命令服务：插件可以注册本地命令（只在渲染进程执行），
 * 未注册实现的命令会转发给主进程的命令服务。
 */
export class CommandsService extends Service {
  static inject = ['ipc']

  private readonly owner: Context
  private readonly local = new Map<string, Command>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
    this.owner = ctx
  }

  register(command: Command): Disposable {
    if (this.local.has(command.id)) throw new Error(`命令 ${command.id} 已被注册`)
    this.local.set(command.id, command)

    const existing = store.commands.find((item) => item.id === command.id)
    if (existing) {
      existing.title = command.title ?? existing.title
      existing.category = command.category ?? existing.category
      existing.keybinding = command.keybinding ?? existing.keybinding
    } else {
      store.commands.push({
        id: command.id,
        title: command.title ?? command.id,
        category: command.category,
        keybinding: command.keybinding,
        pluginId: pluginIdOf(this.ctx),
      })
    }

    return this.ctx.effect(() => () => {
      this.local.delete(command.id)
      if (isDeclaredCommand(command.id)) return
      const index = store.commands.findIndex((item) => item.id === command.id)
      if (index >= 0) store.commands.splice(index, 1)
    })
  }

  has(id: string): boolean {
    return this.local.has(id) || store.commands.some((item) => item.id === id)
  }

  list(): CommandInfo[] {
    return store.commands
  }

  async execute<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const command = this.local.get(id)
    if (command) return (await command.handler(...args)) as T
    return this.owner.ipc.invoke<T>('mics.kernel', 'commands/execute', { id, args })
  }
}
