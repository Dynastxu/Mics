import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'

/**
 * 示例插件的主进程部分。
 *
 * 页面碰不到文件，所以「写文件 / 读文件」只能是这里的 RPC：
 * 渲染进程通过 window.mics 发消息，真正落盘发生在主进程。
 *
 * 它写的是 <userData>/hello-tool/note.txt —— 故意放在插件目录之外，
 * 用来验证卸载脚本能清掉插件自己创建的东西。
 */
export const name = 'demo.hello-tool'
export const inject = ['ipc']

const VERSION = '0.1.0'

function notesDir(): string {
  return path.join(app.getPath('userData'), 'hello-tool')
}

function notesFile(): string {
  return path.join(notesDir(), 'note.txt')
}

export function apply(ctx: Context): void {
  ctx.ipc.handle('hello/version', () => VERSION)

  ctx.ipc.handle<{ text?: string }>('file/write', ({ text } = {}) => {
    mkdirSync(notesDir(), { recursive: true })
    const content = text ?? `written at ${new Date().toISOString()}`
    writeFileSync(notesFile(), content, 'utf8')
    return { path: notesFile(), text: content }
  })

  ctx.ipc.handle('file/read', () => {
    try {
      return { path: notesFile(), text: readFileSync(notesFile(), 'utf8') }
    } catch {
      return { path: notesFile(), text: '' }
    }
  })
}

export default { name, inject, apply }
