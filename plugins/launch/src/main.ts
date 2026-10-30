import { app, shell } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import { AUTH_CREDENTIALS, SHELL_EXECUTE } from '@mics/sdk'
import type { AuthCredentialsCapability, ShellExecuteCapability } from '@mics/sdk'
import { listInstances, markInstanceLaunched, resolveInstance } from './instances'
import {
  deleteInstanceDirectory,
  deleteInstanceMod,
  describeInstance,
  listInstanceLogs,
  listInstanceMods,
  measureInstanceUsage,
  readInstanceLog,
  resolveInstanceArea,
  setInstanceModEnabled,
} from './instanceFiles'
import { InstanceFilesMissingError, launchInstance } from './launch'
import { waitForGameWindow } from './gameWindow'
import { LaunchRuntime, isProcessAlive, type PersistedProcess } from './runtime'
import type {
  InstanceArea,
  InstanceLogRequest,
  InstanceModDeleteRequest,
  InstanceModToggleRequest,
  InstanceRef,
  InstanceRevealRequest,
  LaunchOutcome,
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
  const log = ctx.logger('mics.launch')

  const runtime = new LaunchRuntime({
    load: () => ctx.storage.get<PersistedProcess[]>(RUNNING_KEY, []),
    save: (records) => ctx.storage.set(RUNNING_KEY, records),
    publish: (state) => ctx.ipc.broadcast(LAUNCH_STATE_TOPIC, state),
  })
  runtime.restore()
  const restored = runtime.snapshot().instances.length
  if (restored > 0) log.info('已恢复 %d 个仍在运行的实例进程', restored)
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
  const followLaunch = async (instanceId: string, pid: number): Promise<void> => {
    const result = await waitForGameWindow(pid, WINDOW_PROBE_TIMEOUT)
    log.info('实例 %s 的窗口探测结果：%s（pid=%s）', instanceId, result, pid)

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
    const enabled = params?.enabled === true
    const result = setInstanceModEnabled(dataDir, id, fileName, enabled)
    log.info('实例 %s 的 Mod %s 已%s', id, fileName, enabled ? '启用' : '禁用')
    return result
  })

  ctx.ipc.handle<InstanceModDeleteRequest>('instances/mods/delete', (params) => {
    const id = instanceIdOf(params)
    const fileName = typeof params?.fileName === 'string' ? params.fileName : ''
    const result = deleteInstanceMod(dataDir, id, fileName)
    log.info('实例 %s 的 Mod %s 已删除', id, fileName)
    return result
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
    log.info('实例 %s 已删除', id)
    return { id }
  })

  ctx.ipc.handle<LaunchRequest>('instances/launch', async ({ id, accountId }): Promise<LaunchOutcome> => {
    const instance = resolveInstance(dataDir, id)
    if (!instance) throw new Error('实例不存在或缺少版本文件')
    if (instance.installState !== 'ready') throw new Error('实例尚未下载完成，暂时无法启动')
    if (preparing.has(id)) throw new Error('该实例正在启动中')

    preparing.add(id)
    try {
      // 账户凭据由账户插件决定（正版 / 离线），启动管线只消费结果
      const credentials = await ctx.capabilities
        .require<AuthCredentialsCapability>(AUTH_CREDENTIALS)
        .resolve(accountId)

      const memory = Number(ctx.storage.get<string>('maxMemory', '4096'))
      const memoryMb = Number.isFinite(memory) ? memory : 4096
      log.info(
        '开始启动实例 %s（版本 %s，账户 %s，内存 %dMB）',
        instance.id,
        instance.version.id,
        credentials.name,
        memoryMb,
      )

      // 启动方式由 provider 决定：本机进程只是默认实现，沙箱插件可以整体替换
      const shellCapability = ctx.capabilities.require<ShellExecuteCapability>(SHELL_EXECUTE)

      const launched = await launchInstance(shellCapability, instance, {
        credentials,
        launcherVersion: app.getVersion(),
        memoryMb,
        onLog: (level, message) => {
          if (level === 'warn') log.warn('%s', message)
          else log.info('%s', message)
        },
      })
      markInstanceLaunched(instance, credentials.name)

      runtime.add(instance.id, launched.pid, launched.child)
      // 游戏进程退出时记一条日志；监听只触发一次，不需要额外回收
      launched.child.once('exit', (code, signal) => {
        log.info(
          '实例 %s 的游戏进程 %d 已退出（code=%s，signal=%s）',
          instance.id,
          launched.pid,
          String(code ?? '-'),
          String(signal ?? '-'),
        )
      })
      log.info('实例 %s 已启动：pid=%d', instance.id, launched.pid)
      void followLaunch(instance.id, launched.pid)

      return { status: 'launched', pid: launched.pid } satisfies LaunchOutcome
    } catch (error) {
      // 文件缺失是可预期结果：把清单交回界面，由用户决定是否交给下载管线补全
      if (error instanceof InstanceFilesMissingError) {
        log.warn(
          '实例 %s 缺少 %d 个必要文件，等待用户确认补全',
          instance.id,
          error.files.length,
        )
        return { status: 'missing-files', files: error.files } satisfies LaunchOutcome
      }
      log.error('启动实例 %s 失败', id, error)
      throw error
    } finally {
      preparing.delete(id)
    }
  })

  ctx.ipc.handle<TerminateRequest>('instances/terminate', async ({ id }) => {
    const terminated = await runtime.terminate(id)
    log.info('终止实例 %s：结束 %d 个进程', id, terminated)
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
    log.info('启动设置已更新：重复启动=%s，最大内存=%dMB', readBehavior(), readMemory())
    return {
      repeatBehavior: readBehavior(),
      maxMemory: readMemory(),
    } satisfies LaunchSettings
  })
}

export default defineMainPlugin({ name, inject, apply })
