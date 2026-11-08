import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'

/**
 * 隔离探针（isolated）。
 *
 * 这个插件声明 `trust: "isolated"`：它跑在独立子进程里，但**没有**加载
 * `--permission`。所以越权操作（写白名单外的目录、读系统文件、起子进程）
 * 都会成功——正好用来和 `demo.probe-sandboxed` 对照。
 */
export const name = 'demo.probe-isolated'
export const inject = ['ipc', 'host']

interface ProbeResult {
  ok: boolean
  detail: string
}

async function attempt(action: () => unknown): Promise<ProbeResult> {
  try {
    const value = await action()
    return { ok: true, detail: typeof value === 'string' ? value : JSON.stringify(value) }
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    return { ok: false, detail: `${cause.code ? cause.code + ' ' : ''}${cause.message}` }
  }
}

function systemFile(): string {
  return process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname'
}

export function apply(ctx: Context): void {
  const allowedDir = path.join(ctx.host.paths.userData, 'probe-isolated')
  const outsideFile = path.join(os.tmpdir(), `mics-probe-isolated-${process.pid}.txt`)

  ctx.ipc.handle<{ op?: unknown }>('probe/run', async (params) => {
    const op = String(params?.op ?? 'info')

    if (op === 'info') {
      return {
        ok: true,
        detail: [
          `pid=${process.pid}`,
          `child=${typeof process.send === 'function'}`,
          `trust=isolated`,
          `userData=${ctx.host.paths.userData}`,
          `pluginDir=${ctx.host.paths.pluginDir}`,
          `allowed=${allowedDir}`
        ].join('\n')
      }
    }

    if (op === 'write-allowed') {
      return await attempt(() => {
        mkdirSync(allowedDir, { recursive: true })
        writeFileSync(path.join(allowedDir, 'note.txt'), 'ok')
        return `写入成功：${path.join(allowedDir, 'note.txt')}`
      })
    }

    if (op === 'write-outside') {
      return await attempt(() => {
        writeFileSync(outsideFile, 'escaped')
        return `写入成功（预期：isolated 不拦）：${outsideFile}`
      })
    }

    if (op === 'read-system') {
      return await attempt(() => {
        const text = readFileSync(systemFile(), 'utf8')
        return `读取成功（${text.length} 字节）：${systemFile()}`
      })
    }

    if (op === 'spawn') {
      return await attempt(
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
              stdio: 'ignore'
            })
            child.once('error', reject)
            child.once('exit', (code) => resolve(`子进程退出码 ${String(code)}`))
          })
      )
    }

    return { ok: false, detail: `未知操作：${op}` }
  })
}

export default defineMainPlugin({ name, inject, apply })
