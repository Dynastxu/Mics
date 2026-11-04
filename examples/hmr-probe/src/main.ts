import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'

/**
 * HMR 探针。
 *
 * 关键点：`evaluatedAt` 在**模块求值**时生成。只有模块真的被重新 import
 * （HMR 替换，或内核的 remove + create 回退）它才会变。
 *
 * 日志里同时打 `import.meta.url`：
 * - HMR：URL 不变，时间戳变；
 * - 内核回退重载：URL 带 `?mics=<时间戳>`；
 * - 什么都没发生：时间戳不变。
 */
export const name = 'demo.hmr-probe'
export const inject = ['ipc']

const evaluatedAt = new Date().toISOString()

export function apply(ctx: Context): void {
  const moduleUrl = import.meta.url
  ctx.logger(name).info('apply v2 · evaluatedAt=%s · url=%s', evaluatedAt, moduleUrl)

  // 让渲染端/agent 能主动查询当前实例，不用翻日志
  ctx.ipc.handle('probe/info', () => ({
    evaluatedAt,
    url: moduleUrl,
    pid: process.pid
  }))
}

export default defineMainPlugin({ name, inject, apply })
