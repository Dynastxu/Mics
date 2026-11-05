import { app, shell } from 'electron'
import type { Context } from 'cordis'
import path from 'node:path'
import { defineMainPlugin } from '@mics/sdk/main'
import { AUTH_CREDENTIALS, SHELL_EXECUTE } from '@mics/sdk'
import type { AuthCredentialsCapability, ShellExecuteCapability } from '@mics/sdk'
import { detectJavaRuntimes, resolveJavaPath } from '@mics/java'
import {
  discoverInstance,
  listInstances,
  markInstanceLaunched,
  readInstanceSettings,
  resolveInstance,
  writeInstanceSettings
} from './instances'
import {
  deleteInstanceDirectory,
  deleteInstanceMod,
  describeInstance,
  listInstanceLogs,
  listInstanceMods,
  listInstanceSaves,
  measureInstanceUsage,
  readInstanceLog,
  resolveInstanceArea,
  setInstanceModEnabled
} from './instanceFiles'
import { InstanceFilesMissingError, launchInstance } from './launch'
import { waitForGameWindow } from './gameWindow'
import { LaunchRuntime, isProcessAlive, type PersistedProcess } from './runtime'
import {
  DEFAULT_MAX_MEMORY,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  normalizeInstanceSettings,
  normalizeJavaPaths,
  normalizeMemoryMb,
  normalizeRepeatBehavior,
  normalizeWindowSize,
  parseJvmArgs
} from './settings'
import type {
  InstanceArea,
  InstanceLaunchSettings,
  InstanceLogRequest,
  InstanceModDeleteRequest,
  InstanceModToggleRequest,
  InstanceRef,
  InstanceRevealRequest,
  JavaPathStatus,
  LaunchOutcome,
  LaunchRequest,
  LaunchSettings,
  TerminateRequest,
  TerminateResult
} from './shared'
import { LAUNCH_STATE_TOPIC } from './shared'

export const name = 'mics.launch'
export const inject = ['ipc', 'storage', 'capabilities']

/** 运行中进程记录：用于重启后认领仍在运行的游戏 */
const RUNNING_KEY = 'running'
/** 重复启动行为 */
const BEHAVIOR_KEY = 'repeatLaunchBehavior'
const MEMORY_KEY = 'maxMemory'
/** 候选 Java 路径；数组不受配置 schema 约束，由本插件自行校验 */
const JAVA_PATHS_KEY = 'javaPaths'
const WINDOW_WIDTH_KEY = 'windowWidth'
const WINDOW_HEIGHT_KEY = 'windowHeight'
const JVM_ARGS_KEY = 'jvmArgs'
/** 等待游戏窗口的上限；超时后按「已在运行」处理，避免按钮一直停在启动中 */
const WINDOW_PROBE_TIMEOUT = 120_000
/** 无法探测窗口的平台（非 Windows / 无 PowerShell）下，稍等片刻就恢复按钮 */
const FALLBACK_RUNNING_DELAY = 4_000

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
  return value === 'logs' || value === 'mods' || value === 'saves' ? value : 'root'
}

/** 设置里的文本项：非字符串直接拒绝，避免把错误类型写进 storage */
function textSetting(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  return value.trim()
}

/** 写入端严格些：只接受字符串数组，读取端再用 normalizeJavaPaths 兜底 */
function javaPathsSetting(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Java 路径列表必须是数组')
  if (value.some((entry) => typeof entry !== 'string')) throw new Error('Java 路径必须是字符串')
  return normalizeJavaPaths(value)
}

/** 把一个候选路径解析成设置页与启动共用的状态 */
function javaStatusOf(javaPath: string): JavaPathStatus {
  const runtime = resolveJavaPath(javaPath)
  return { path: javaPath, java: runtime?.java ?? null, major: runtime?.major ?? null }
}

/**
 * 候选 Java 路径统一存成 `bin` 目录。
 *
 * 用户习惯看到 `...\jre1.8.0_471\bin` 这样的路径；而输入允许是 java 可执行文件、
 * Java 主目录或 bin 目录，三种写法在这里归一到同一个存储形态，也顺带完成去重。
 * 解析失败时返回 null，由调用方决定是保留旧条目还是拒绝新条目。
 */
function javaBinDir(javaPath: string): string | null {
  const runtime = resolveJavaPath(javaPath)
  return runtime ? path.dirname(runtime.java) : null
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
    publish: (state) => ctx.ipc.broadcast(LAUNCH_STATE_TOPIC, state)
  })
  runtime.restore()
  const restored = runtime.snapshot().instances.length
  if (restored > 0) log.info('已恢复 %d 个仍在运行的实例进程', restored)
  ctx.effect(() => () => runtime.dispose())

  const readTextSetting = (key: string): string => {
    const value = ctx.storage.get<unknown>(key, '')
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * 当前生效的启动设置。
   *
   * 范围由清单 schema（内存 1024–32768、窗口 320–16384）校验，storage 取值时也会
   * 按 schema 归一化；这里用同一套纯函数兜底，运行时夹取统一在 buildLaunchPlan()，
   * 避免两处规则漂移。候选 Java 路径不在 schema 里，读取时同样归整。
   */
  const readSettings = (): LaunchSettings => ({
    repeatBehavior: normalizeRepeatBehavior(ctx.storage.get<string>(BEHAVIOR_KEY, 'prompt')),
    maxMemory: normalizeMemoryMb(ctx.storage.get<unknown>(MEMORY_KEY, DEFAULT_MAX_MEMORY)),
    javaPaths: normalizeJavaPaths(ctx.storage.get<unknown>(JAVA_PATHS_KEY, [])),
    windowWidth: normalizeWindowSize(
      ctx.storage.get<unknown>(WINDOW_WIDTH_KEY, DEFAULT_WINDOW_WIDTH),
      DEFAULT_WINDOW_WIDTH
    ),
    windowHeight: normalizeWindowSize(
      ctx.storage.get<unknown>(WINDOW_HEIGHT_KEY, DEFAULT_WINDOW_HEIGHT),
      DEFAULT_WINDOW_HEIGHT
    ),
    jvmArgs: readTextSetting(JVM_ARGS_KEY)
  })

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

  ctx.ipc.handle<InstanceRef>('instances/saves', (params) => {
    return listInstanceSaves(dataDir, instanceIdOf(params))
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

  ctx.ipc.handle<InstanceRef>('instances/settings', (params) => {
    const instance = discoverInstance(dataDir, instanceIdOf(params))
    if (!instance) throw new Error('实例不存在')
    return readInstanceSettings(instance)
  })

  /**
   * 更新实例级启动设置。
   *
   * 渲染端只发变化的字段：以现有设置打底再整体归一化，避免漏字段把已保存的值清掉。
   */
  ctx.ipc.handle<InstanceRef & Partial<InstanceLaunchSettings>>(
    'instances/settings/set',
    (params) => {
      const id = instanceIdOf(params)
      const instance = discoverInstance(dataDir, id)
      if (!instance) throw new Error('实例不存在')

      const next = normalizeInstanceSettings({ ...readInstanceSettings(instance), ...params })
      if (next.javaMode === 'specified') {
        if (!next.javaPath) throw new Error('指定 Java 需要先选择一个 Java')
        // 与全局候选一样统一存 bin 目录，也接受可执行文件 / 主目录写法
        const runtime = resolveJavaPath(next.javaPath)
        if (!runtime) {
          throw new Error(
            `Java 路径无效：${next.javaPath}（需要一个 java 可执行文件、Java 主目录或 bin 目录）`
          )
        }
        const required = instance.version?.javaVersion?.majorVersion ?? 8
        if (runtime.major < required) {
          throw new Error(
            `该实例需要 Java ${required} 或更高版本，所选 Java ${runtime.major} 不满足`
          )
        }
        next.javaPath = path.dirname(runtime.java)
      }

      writeInstanceSettings(instance, next)
      log.info(
        '实例 %s 的启动设置已更新：Java=%s，JVM 参数=%s，窗口=%s',
        id,
        next.javaMode === 'specified' ? next.javaPath : '自动',
        next.followGlobalJvmArgs ? '跟随全局' : `${parseJvmArgs(next.jvmArgs).length} 项`,
        next.followGlobalWindow ? '跟随全局' : `${next.windowWidth}×${next.windowHeight}`
      )
      return next
    }
  )

  ctx.ipc.handle<LaunchRequest>(
    'instances/launch',
    async ({ id, accountId }): Promise<LaunchOutcome> => {
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

        const settings = readSettings()
        const instanceSettings = readInstanceSettings(instance)
        // 实例指定了 Java 就只用它；否则沿用全局候选列表（为空时自动检测）
        const javaPaths =
          instanceSettings.javaMode === 'specified' && instanceSettings.javaPath
            ? [instanceSettings.javaPath]
            : settings.javaPaths
        const windowWidth = instanceSettings.followGlobalWindow
          ? settings.windowWidth
          : instanceSettings.windowWidth
        const windowHeight = instanceSettings.followGlobalWindow
          ? settings.windowHeight
          : instanceSettings.windowHeight
        const jvmArgs = instanceSettings.followGlobalJvmArgs
          ? parseJvmArgs(settings.jvmArgs)
          : parseJvmArgs(instanceSettings.jvmArgs)

        log.info(
          '开始启动实例 %s（版本 %s，账户 %s，内存 %dMB，窗口 %d×%d，Java=%s）',
          instance.id,
          instance.version.id,
          credentials.name,
          settings.maxMemory,
          windowWidth,
          windowHeight,
          instanceSettings.javaMode === 'specified' ? '实例指定' : '自动'
        )

        // 启动方式由 provider 决定：本机进程只是默认实现，沙箱插件可以整体替换
        const shellCapability = ctx.capabilities.require<ShellExecuteCapability>(SHELL_EXECUTE)

        const launched = await launchInstance(shellCapability, instance, {
          credentials,
          launcherVersion: app.getVersion(),
          memoryMb: settings.maxMemory,
          javaPaths,
          windowWidth,
          windowHeight,
          jvmArgs,
          onLog: (level, message) => {
            if (level === 'warn') log.warn('%s', message)
            else log.info('%s', message)
          }
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
            String(signal ?? '-')
          )
        })
        log.info('实例 %s 已启动：pid=%d', instance.id, launched.pid)
        void followLaunch(instance.id, launched.pid)

        return { status: 'launched', pid: launched.pid } satisfies LaunchOutcome
      } catch (error) {
        // 文件缺失是可预期结果：把清单交回界面，由用户决定是否交给下载管线补全
        if (error instanceof InstanceFilesMissingError) {
          log.warn('实例 %s 缺少 %d 个必要文件，等待用户确认补全', instance.id, error.files.length)
          return { status: 'missing-files', files: error.files } satisfies LaunchOutcome
        }
        log.error('启动实例 %s 失败', id, error)
        throw error
      } finally {
        preparing.delete(id)
      }
    }
  )

  ctx.ipc.handle<TerminateRequest>('instances/terminate', async ({ id }) => {
    const terminated = await runtime.terminate(id)
    log.info('终止实例 %s：结束 %d 个进程', id, terminated)
    return { terminated } satisfies TerminateResult
  })

  ctx.ipc.handle('settings/get', () => readSettings())

  ctx.ipc.handle<Partial<LaunchSettings>>('settings/set', (params) => {
    if (params?.repeatBehavior !== undefined) {
      ctx.storage.set(BEHAVIOR_KEY, normalizeRepeatBehavior(params.repeatBehavior))
    }
    if (params?.maxMemory !== undefined) {
      const memory = Number(params.maxMemory)
      if (!Number.isFinite(memory)) throw new Error('最大内存必须是数字')
      // storage 会按清单 schema 校验 1024–32768
      ctx.storage.set(MEMORY_KEY, Math.round(memory))
    }
    if (params?.javaPaths !== undefined) {
      const incoming = javaPathsSetting(params.javaPaths)
      // 只校验这次新增的条目：已保存的路径可能在 JVM 被卸载后失效，
      // 不能因为一个旧条目就让「删除 / 添加其它 Java」也保存不了。
      const saved = new Set(
        normalizeJavaPaths(ctx.storage.get<unknown>(JAVA_PATHS_KEY, [])).map((entry) =>
          entry.toLowerCase()
        )
      )
      const next: string[] = []
      const seen = new Set<string>()
      for (const javaPath of incoming) {
        const canonical = javaBinDir(javaPath)
        if (!canonical) {
          if (!saved.has(javaPath.toLowerCase())) {
            throw new Error(
              `Java 路径无效：${javaPath}（需要一个 java 可执行文件、Java 主目录或 bin 目录）`
            )
          }
          if (!seen.has(javaPath)) {
            seen.add(javaPath)
            next.push(javaPath)
          }
          continue
        }
        if (seen.has(canonical)) continue
        seen.add(canonical)
        next.push(canonical)
      }
      ctx.storage.set(JAVA_PATHS_KEY, next)
    }
    if (params?.windowWidth !== undefined) {
      ctx.storage.set(WINDOW_WIDTH_KEY, Math.round(Number(params.windowWidth)))
    }
    if (params?.windowHeight !== undefined) {
      ctx.storage.set(WINDOW_HEIGHT_KEY, Math.round(Number(params.windowHeight)))
    }
    if (params?.jvmArgs !== undefined) {
      ctx.storage.set(JVM_ARGS_KEY, textSetting(params.jvmArgs, 'JVM 参数'))
    }

    const settings = readSettings()
    log.info(
      '启动设置已更新：重复启动=%s，最大内存=%dMB，窗口=%d×%d，候选 Java=%d 个，JVM 参数=%d 项',
      settings.repeatBehavior,
      settings.maxMemory,
      settings.windowWidth,
      settings.windowHeight,
      settings.javaPaths.length,
      parseJvmArgs(settings.jvmArgs).length
    )
    return settings
  })

  /**
   * 候选 Java 路径的解析结果：设置页据此显示每项的版本，
   * 路径失效时 `major` 为空，界面标成「不可用」而不是悄悄删掉。
   */
  ctx.ipc.handle<{ paths?: unknown }>('java/inspect', (params) =>
    normalizeJavaPaths(params?.paths).map(javaStatusOf)
  )

  /** 「自动检测」按钮：扫描本机所有 Java，强制刷新缓存 */
  ctx.ipc.handle('java/detect', (): JavaPathStatus[] =>
    detectJavaRuntimes(true).map((runtime) => ({
      // 与存储形态一致：候选路径以 bin 目录出现
      path: path.dirname(runtime.java),
      java: runtime.java,
      major: runtime.major
    }))
  )
}

export default defineMainPlugin({ name, inject, apply })
