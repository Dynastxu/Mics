import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'

/**
 * 隔离探针（sandboxed）。
 *
 * 只声明了 `${userData}/probe-sandbox` 的读写。在 `sandbox.mode = enforce` 下，
 * 子进程带 `--permission` 启动，所以白名单之外的写、读系统文件、起子进程
 * 都会被引擎拒绝（`ERR_ACCESS_DENIED`）。
 */
export const name = 'demo.probe-sandboxed'
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
    const cause = error as NodeJS.ErrnoException & { permission?: string }
    const code = cause.code ?? ''
    const permission = cause.permission ? ` (${cause.permission})` : ''
    return { ok: false, detail: `${code}${permission} ${cause.message}`.trim() }
  }
}

function systemFile(): string {
  return process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname'
}

export function apply(ctx: Context): void {
  const allowedDir = path.join(ctx.host.paths.userData, 'probe-sandbox')
  const outsideFile = path.join(os.tmpdir(), `mics-probe-sandboxed-${process.pid}.txt`)

  ctx.ipc.handle<{ op?: unknown }>('probe/run', async (params) => {
    const op = String(params?.op ?? 'info')

    if (op === 'info') {
      return {
        ok: true,
        detail: [
          `pid=${process.pid}`,
          `child=${typeof process.send === 'function'}`,
          `trust=sandboxed`,
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
        return `写入成功（预期：受限模式下应被拒绝）：${outsideFile}`
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
