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
 *
 * 路径来自 `ctx.host.paths` 而不是 `electron`：这个插件还要能在子进程里跑，
 * 那里没有 `electron` 模块。
 */
export const name = 'demo.hello-tool'
export const inject = ['ipc', 'storage', 'host']

const VERSION = '0.1.0'
const DEFAULT_NOTE_FILE = 'note.txt'

function notesDir(userData: string): string {
  return path.join(userData, 'hello-tool')
}

/** 文件名来自清单 schema（`contributes.configuration`），插件管理页的详情里可直接改 */
function notesFile(ctx: Context): string {
  const name = ctx.storage.get<string>('noteFileName', DEFAULT_NOTE_FILE)?.trim()
  return path.join(notesDir(ctx.host.paths.userData), name || DEFAULT_NOTE_FILE)
}

export function apply(ctx: Context): void {
  ctx.ipc.handle('hello/version', () => VERSION)

  ctx.ipc.handle<{ text?: string }>('file/write', ({ text } = {}) => {
    mkdirSync(notesDir(ctx.host.paths.userData), { recursive: true })
    const content = text ?? `written at ${new Date().toISOString()}`
    writeFileSync(notesFile(ctx), content, 'utf8')
    return { path: notesFile(ctx), text: content }
  })

  ctx.ipc.handle('file/read', () => {
    try {
      return { path: notesFile(ctx), text: readFileSync(notesFile(ctx), 'utf8') }
    } catch {
      return { path: notesFile(ctx), text: '' }
    }
  })
}

export default { name, inject, apply }
