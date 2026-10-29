import { spawn, type StdioOptions } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { SHELL_EXECUTE } from '@mics/sdk'
import type { ShellExecSpec, ShellExecuteCapability, ShellProcess } from '@mics/sdk'

export const name = 'mics.shell'
export const inject = ['capabilities']

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * shell.execute 的本机实现。
 *
 * 这一层只做「把 spec 变成子进程」，不掺业务：日志文件由这里打开、写完后随
 * spawn 结束关闭，调用方拿到的是一个与平台无关的 ShellProcess。
 * 换成沙箱实现时，替换的是这个 provider，调用方不用改。
 */
const localShell: ShellExecuteCapability = {
  label: 'local',

  spawn(spec: ShellExecSpec): Promise<ShellProcess> {
    return new Promise((resolve, reject) => {
      let fd: number | undefined
      try {
        fd = spec.logFile ? openSync(spec.logFile, 'a') : undefined
      } catch (error) {
        reject(toError(error))
        return
      }

      // spawn 成功 / 失败都要关掉宿主这一侧的 fd：子进程已经拿到自己的副本
      let closed = false
      const closeLog = (): void => {
        if (closed || fd === undefined) return
        closed = true
        try {
          closeSync(fd)
        } catch {
          // 已经被关闭：不需要再处理
        }
      }

      let child
      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          detached: spec.detached ?? false,
          stdio: (fd === undefined ? 'ignore' : ['ignore', fd, fd]) as StdioOptions,
          windowsHide: true,
          env: spec.env ?? process.env,
        })
      } catch (error) {
        closeLog()
        reject(toError(error))
        return
      }

      const handle: ShellProcess = {
        get pid() {
          return child.pid
        },
        kill(signal) {
          try {
            child.kill(signal as NodeJS.Signals | undefined)
          } catch {
            // 进程已经退出
          }
        },
        detach() {
          child.unref()
        },
        once(event, listener) {
          child.once(event, listener as (...args: unknown[]) => void)
          return () => child.off(event, listener as (...args: unknown[]) => void)
        },
      }

      child.once('spawn', () => {
        closeLog()
        resolve(handle)
      })
      child.once('error', (error) => {
        closeLog()
        reject(error)
      })
    })
  },
}

export function apply(ctx: Context): void {
  ctx.capabilities.provide(SHELL_EXECUTE, localShell, { label: localShell.label })
  ctx.logger('mics.shell').info('shell.execute 能力已注册（provider=%s）', localShell.label)
}

export default defineMainPlugin({ name, inject, apply })
