import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { PluginId, ResolvedPermissions } from '@mics/sdk'
import type { HostToWorker, WorkerToHost } from '@mics/plugin-host'

/**
 * 插件子进程的宿主侧。
 *
 * 只做三件事：按权限生成 Node 启动参数、维持一次握手、把 RPC 转成进程消息。
 * 生命周期与 cordis 的 fiber 解耦——插件在子进程里有自己的 Context。
 */

export interface WorkerRuntimePaths {
  userData: string
  pluginDir: string
  temp: string
  home: string
}

export interface WorkerHostOptions {
  id: PluginId
  /** 插件主进程入口的绝对路径 */
  entry: string
  /** worker 运行时自身的入口（绝对路径） */
  workerEntry: string
  permissions: ResolvedPermissions
  storage: Record<string, unknown>
  paths: WorkerRuntimePaths
  app: { version: string; isDev: boolean }
  /**
   * `true` → 加 `--permission`，文件与子进程由引擎强制（enforce）；
   * `false` → 只隔离进程，不做引擎限制（audit）。
   */
  enforce: boolean
  /**
   * worker 运行时自身需要读取的路径（bundle 与其依赖）。
   * 打包后通常只有 worker 文件与 `node_modules` 根。
   */
  runtimeReadPaths?: string[]
  onRegister?: (method: string) => void
  onUnregister?: (method: string) => void
  onStorageSet?: (key: string, value: unknown) => void
  onStorageDelete?: (key: string) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  onExit?: (code: number | null) => void
}

/**
 * 把权限声明翻成 Node 的启动参数。
 *
 * 只有 enforce 才产出参数：audit 模式的目的是收集“如果开了会怎样”，
 * 一旦加上 `--permission`，越界就会真的失败，收集不到数据。
 */
export function buildWorkerFlags(options: {
  enforce: boolean
  workerEntry: string
  pluginDir: string
  permissions: ResolvedPermissions
  runtimeReadPaths?: string[]
}): string[] {
  if (!options.enforce) return []

  const flags: string[] = ['--permission']
  const read = new Set<string>([
    options.workerEntry,
    options.pluginDir,
    ...(options.runtimeReadPaths ?? []),
    ...options.permissions.fs.read.resolved,
    ...options.permissions.fs.meta.resolved,
    ...options.permissions.fs.write.resolved
  ])
  for (const path of read) flags.push(`--allow-fs-read=${path}`)
  for (const path of new Set(options.permissions.fs.write.resolved)) {
    flags.push(`--allow-fs-write=${path}`)
  }
  // 子进程权限是全有全无：声明了 exec 才放开，具体允许哪个程序由 broker 再判
  if (options.permissions.exec.length > 0) flags.push('--allow-child-process')

  return flags
}

const DISPOSE_TIMEOUT_MS = 5_000

/**
 * 按声明的可写目录预建目录。
 *
 * Node 的 `--allow-fs-write=<dir>` 只允许「在 dir 里创建条目」，**不包括创建 dir 本身**。
 * 所以插件写 `${userData}/foo/note.txt` 时，`foo` 必须已经存在——由宿主建好，
 * 插件才能把声明的目录当成「存在且可写」来用。
 */
export function ensureWriteRoots(
  permissions: ResolvedPermissions,
  onError?: (dir: string, error: unknown) => void
): void {
  for (const dir of permissions.fs.write.resolved) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      onError?.(dir, error)
    }
  }
}

export class PluginWorkerHost {
  readonly id: PluginId
  private readonly child: ChildProcess
  private readonly options: WorkerHostOptions
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly methods = new Set<string>()
  private seq = 0
  private disposed = false
  private readonly ready: Promise<string[]>

  private constructor(
    options: WorkerHostOptions,
    child: ChildProcess,
    ready: Promise<string[]>
  ) {
    this.options = options
    this.child = child
    this.id = options.id
    this.ready = ready
  }

  static async start(options: WorkerHostOptions): Promise<PluginWorkerHost> {
    const flags = buildWorkerFlags({
      enforce: options.enforce,
      workerEntry: options.workerEntry,
      pluginDir: options.paths.pluginDir,
      permissions: options.permissions,
      runtimeReadPaths: options.runtimeReadPaths
    })

    const child = fork(options.workerEntry, [], {
      execArgv: flags,
      // 在 Electron 主进程里，execPath 是 electron.exe；这个环境变量让它以纯 Node 运行
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 结构化克隆：Buffer / Date / Map 都能原样过界
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })

    let resolveReady: (methods: string[]) => void = () => undefined
    let rejectReady: (error: Error) => void = () => undefined
    const ready = new Promise<string[]>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const host = new PluginWorkerHost(options, child, ready)

    child.stdout?.on('data', (chunk: Buffer) => {
      options.onLog?.('info', chunk.toString('utf8').trimEnd())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      options.onLog?.('warn', chunk.toString('utf8').trimEnd())
    })

    child.on('message', (message: WorkerToHost) => host.onMessage(message, resolveReady, rejectReady))
    child.once('error', (error) => {
      rejectReady(error)
      host.failAll(error)
    })
    child.once('exit', (code) => {
      rejectReady(new Error(`插件进程 ${options.id} 退出（${String(code)}）`))
      host.failAll(new Error(`插件进程 ${options.id} 已退出`))
      options.onExit?.(code)
    })

    // 子进程一启动就要自己的配置，所以握手由宿主发起
    host.post({ t: 'bootstrap', pluginId: options.id, entry: options.entry, storage: options.storage, paths: options.paths, app: options.app })

    return host
  }

  /** 子进程报告 ready 时的方法列表 */
  async whenReady(): Promise<string[]> {
    return await this.ready
  }

  has(method: string): boolean {
    return this.methods.has(method)
  }

  invoke<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(`插件 ${this.id} 的子进程已停止`))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.post({ t: 'invoke', id, method, params })
    })
  }

  /** 派发事件到子进程；`waterfall` 会带回监听器改写后的结果 */
  dispatchEvent(topic: string, payload: unknown, mode: 'emit' | 'waterfall'): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(`插件 ${this.id} 的子进程已停止`))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.post({ t: 'event', id, topic, mode, payload })
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    const done = new Promise<void>((resolve) => {
      this.child.once('message', (message: WorkerToHost) => {
        if (message.t === 'disposed') resolve()
      })
      setTimeout(resolve, DISPOSE_TIMEOUT_MS)
    })
    this.post({ t: 'dispose' })
    await done
    this.disposed = true
    this.child.kill()
    this.failAll(new Error(`插件 ${this.id} 已停止`))
  }

  private post(message: HostToWorker): void {
    this.child.send(message)
  }

  private onMessage(
    message: WorkerToHost,
    resolveReady: (methods: string[]) => void,
    rejectReady: (error: Error) => void
  ): void {
    switch (message.t) {
      case 'ready':
        for (const method of message.methods) {
          this.methods.add(method)
          this.options.onRegister?.(method)
        }
        resolveReady(message.methods)
        return
      case 'failed':
        rejectReady(new Error(`${message.stage}：${message.message}`))
        return
      case 'register':
        this.methods.add(message.method)
        this.options.onRegister?.(message.method)
        return
      case 'unregister':
        this.methods.delete(message.method)
        this.options.onUnregister?.(message.method)
        return
      case 'storage:set':
        this.options.onStorageSet?.(message.key, message.value)
        return
      case 'storage:delete':
        this.options.onStorageDelete?.(message.key)
        return
      case 'result': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.ok) entry.resolve(message.value)
        else entry.reject(new Error(message.error))
        return
      }
      case 'event-result': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.ok) entry.resolve(message.value)
        else entry.reject(new Error(message.error))
        return
      }
      case 'log':
        this.options.onLog?.(message.level, message.message)
        return
      case 'disposed':
        return
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
