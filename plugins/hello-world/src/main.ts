import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'

export const name = 'mics.hello-world'
export const inject = ['ipc', 'commands', 'storage']

interface GreetResult {
  message: string
  count: number
}

/**
 * 主进程侧的 Hello World：
 * 通过 ctx.ipc.handle 暴露方法、ctx.commands 注册命令、
 * ctx.storage 持久化计数。所有注册都挂在插件 fiber 上，卸载即回收。
 */
export function apply(ctx: Context): void {
  let count = ctx.storage.get<number>('greetCount', 0) ?? 0

  const greet = (target?: string): GreetResult => {
    count += 1
    ctx.storage.set('greetCount', count)
    const message = `你好，${target?.trim() || '世界'}！`
    ctx.ipc.emit('hello/greeted', { target: target ?? '', count })
    return { message, count }
  }

  ctx.ipc.handle<{ target?: string }>('greet', (params) => greet(params?.target))
  ctx.ipc.handle('stats', () => ({ count }))

  ctx.commands.register({
    id: 'hello.greet',
    title: 'Hello：打个招呼',
    category: 'Hello',
    handler: () => {
      const result = greet('命令面板')
      ctx.logger('hello').info(result.message)
      return result
    },
  })

  ctx.commands.register({
    id: 'hello.reset',
    title: 'Hello：重置计数',
    category: 'Hello',
    handler: () => {
      count = 0
      ctx.storage.set('greetCount', 0)
      ctx.ipc.emit('hello/greeted', { target: 'reset', count })
      return 0
    },
  })

  ctx.logger('hello').info('Hello World 插件已激活')
}

export default defineMainPlugin({ name, inject, apply })
