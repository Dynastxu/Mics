import { app, shell } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { SHELL_EXECUTE } from '@mics/sdk'
import type { ShellExecuteCapability } from '@mics/sdk'
import { listInstances, markInstanceLaunched, resolveInstance } from './instances'
import {
  deleteInstanceDirectory,
  describeInstance,
  listInstanceLogs,
  listInstanceMods,
  measureInstanceUsage,
  readInstanceLog,
  resolveInstanceArea,
  setInstanceModEnabled,
} from './instanceFiles'
import { launchInstance } from './launch'
import { waitForGameWindow } from './gameWindow'
import { LaunchRuntime, isProcessAlive, type PersistedProcess } from './runtime'
import type {
  InstanceArea,
  InstanceLogRequest,
  InstanceModToggleRequest,
  InstanceRef,
  InstanceRevealRequest,
  LaunchRequest,
  LaunchSettings,
  RepeatLaunchBehavior,
  TerminateRequest,
  TerminateResult,
} from './shared'
import { LAUNCH_STATE_TOPIC } from './shared'

export const name = 'mics.launch'
export const inject = ['ipc', 'storage', 'capabilities']

/** 运行中进程记录：用于重启后认领仍在运行的游戏 */
const RUNNING_KEY = 'running'
/** 重复启动行为 */
const BEHAVIOR_KEY = 'repeatLaunchBehavior'
/** 等待游戏窗口的上限；超时后按「已在运行」处理，避免按钮一直停在启动中 */
const WINDOW_PROBE_TIMEOUT = 120_000
/** 无法探测窗口的平台（非 Windows / 无 PowerShell）下，稍等片刻就恢复按钮 */
const FALLBACK_RUNNING_DELAY = 4_000

function sanitizeUsername(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  return name ? name.slice(0, 16) : 'Steve'
}

function normalizeBehavior(value: unknown): RepeatLaunchBehavior {
  return value === 'launch' || value === 'ignore' ? value : 'prompt'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** IPC 参数来自渲染进程，运行时仍按 unknown 把关 */
function instanceIdOf(params?: InstanceRef): string {
  const id = params?.id
  if (typeof id !== 'string' || !id) throw new Error('无效的实例 id')
  return id
}

function areaOf(value: unknown): InstanceArea {
  return value === 'logs' || value === 'mods' ? value : 'root'
}

/** 结束进程后等待文件锁释放，避免紧接着删除目录时反复重试 */
async function waitForExit(runtime: LaunchRuntime, id: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (runtime.pidsOf(id).length > 0 && Date.now() < deadline) {
    await delay(200)
  }
}

export function apply(ctx: Context): void {
  const dataDir = app.getPath('userData')

  const runtime = new LaunchRuntime({
    load: () => ctx.storage.get<PersistedProcess[]>(RUNNING_KEY, []),
    save: (records) => ctx.storage.set(RUNNING_KEY, records),
    publish: (state) => ctx.ipc.broadcast(LAUNCH_STATE_TOPIC, state),
  })
  runtime.restore()
  ctx.effect(() => () => runtime.dispose())

  const readBehavior = (): RepeatLaunchBehavior =>
    normalizeBehavior(ctx.storage.get<string>(BEHAVIOR_KEY, 'prompt'))

  const readMemory = (): number => {
    const value = Number(ctx.storage.get<string>('maxMemory', '4096'))
    if (!Number.isFinite(value)) return 4096
    return Math.max(1024, Math.min(32768, Math.round(value)))
  }

  /** 正在准备（校验 / 下载 / spawn）的实例，避免页面重挂载后的重复点击 */
  const preparing = new Set<string>()

  /**
   * 等游戏窗口出现后再把「启动中」恢复成「开始游戏」：
   * 窗口一出现就尝试置前（AppActivate，失败也不阻塞状态恢复），然后广播
   * running，渲染端因此不会在窗口还看不见时就提前结束启动状态。
   */
  const followLaunch = async (pid: number): Promise<void> => {
    const result = await waitForGameWindow(pid, WINDOW_PROBE_TIMEOUT)
    console.log(`[mics.launch] 窗口探测 pid=${pid} 结果=${result}`)

    if (result === 'exited') {
      // PowerShell 偶尔会因为拿不到进程信息而误报退出，以 Node 的存活判断为准。
      if (runtime.hasPid(pid) && isProcessAlive(pid)) runtime.markRunning(pid)
      else runtime.remove(pid)
      return
    }

    if (result === 'unsupported') {
      await delay(FALLBACK_RUNNING_DELAY)
      if (runtime.hasPid(pid)) runtime.markRunning(pid)
      return
    }

    runtime.markRunning(pid)
  }

  ctx.ipc.handle('instances/list', () => listInstances(dataDir))

  ctx.ipc.handle('instances/state', () => runtime.snapshot())

  ctx.ipc.handle<InstanceRef>('instances/detail', (params) => {
    return describeInstance(dataDir, instanceIdOf(params))
  })

  ctx.ipc.handle<InstanceRef>('instances/usage', (params) => {
    return measureInstanceUsage(dataDir, instanceIdOf(params))
  })

  ctx.ipc.handle<InstanceRef>('instances/logs', (params) => {
    return listInstanceLogs(dataDir, instanceIdOf(params))
  })

  ctx.ipc.handle<InstanceLogRequest>('instances/log', (params) => {
    const id = instanceIdOf(params)
    const name = typeof params?.name === 'string' ? params.name : ''
    return readInstanceLog(dataDir, id, name)
  })

  ctx.ipc.handle<InstanceRef>('instances/mods', (params) => {
    return listInstanceMods(dataDir, instanceIdOf(params))
  })

  ctx.ipc.handle<InstanceModToggleRequest>('instances/mods/toggle', (params) => {
    const id = instanceIdOf(params)
    const fileName = typeof params?.fileName === 'string' ? params.fileName : ''
    return setInstanceModEnabled(dataDir, id, fileName, params?.enabled === true)
  })

  ctx.ipc.handle<InstanceRevealRequest>('instances/reveal', async (params) => {
    const target = await resolveInstanceArea(dataDir, instanceIdOf(params), areaOf(params?.area))
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  ctx.ipc.handle<InstanceRef>('instances/delete', async (params) => {
    const id = instanceIdOf(params)
    if (preparing.has(id)) throw new Error('实例正在启动，无法删除')

    if (runtime.pidsOf(id).length > 0) {
      await runtime.terminate(id)
      await waitForExit(runtime, id, 8_000)
      if (runtime.pidsOf(id).length > 0) {
        throw new Error('无法结束实例进程，请先手动关闭游戏')
      }
    }

    await deleteInstanceDirectory(dataDir, id)
    return { id }
  })

  ctx.ipc.handle('account/get', () => ({
    username: sanitizeUsername(ctx.storage.get<string>('username', 'Steve')),
  }))

  ctx.ipc.handle<{ username: string }>('account/set', ({ username }) => {
    const name = sanitizeUsername(username)
    ctx.storage.set('username', name)
    return { username: name }
  })

  ctx.ipc.handle<LaunchRequest>('instances/launch', async ({ id, username }) => {
    const instance = resolveInstance(dataDir, id)
    if (!instance) throw new Error('实例不存在或缺少版本文件')
    if (preparing.has(id)) throw new Error('该实例正在启动中')

    preparing.add(id)
    try {
      const name = sanitizeUsername(username || ctx.storage.get<string>('username', 'Steve'))
      const memory = Number(ctx.storage.get<string>('maxMemory', '4096'))

      // 启动方式由 provider 决定：本机进程只是默认实现，沙箱插件可以整体替换
      const shellCapability = ctx.capabilities.require<ShellExecuteCapability>(SHELL_EXECUTE)

      const launched = await launchInstance(shellCapability, instance, {
        username: name,
        launcherVersion: app.getVersion(),
        memoryMb: Number.isFinite(memory) ? memory : 4096,
      })
      markInstanceLaunched(instance, name)

      runtime.add(instance.id, launched.pid, launched.child)
      void followLaunch(launched.pid)

      return { pid: launched.pid }
    } finally {
      preparing.delete(id)
    }
  })

  ctx.ipc.handle<TerminateRequest>('instances/terminate', async ({ id }) => {
    const terminated = await runtime.terminate(id)
    return { terminated } satisfies TerminateResult
  })

  ctx.ipc.handle('settings/get', () => ({
    repeatBehavior: readBehavior(),
    maxMemory: readMemory(),
  }) satisfies LaunchSettings)

  ctx.ipc.handle<Partial<LaunchSettings>>('settings/set', (params) => {
    if (params?.repeatBehavior !== undefined) {
      ctx.storage.set(BEHAVIOR_KEY, normalizeBehavior(params.repeatBehavior))
    }
    if (params?.maxMemory !== undefined) {
      const memory = Number(params.maxMemory)
      if (!Number.isFinite(memory)) throw new Error('最大内存必须是数字')
      // storage 会按清单 schema 校验 1024–32768
      ctx.storage.set('maxMemory', Math.round(memory))
    }
    return {
      repeatBehavior: readBehavior(),
      maxMemory: readMemory(),
    } satisfies LaunchSettings
  })
}

export default defineMainPlugin({ name, inject, apply })
