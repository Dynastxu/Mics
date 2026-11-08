import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { PluginId, ResolvedPermissions } from '@mics/sdk'
import { CAPABILITY_BRIDGES, type CapabilityBridgeSpec } from '@mics/sdk'
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
  /** 子进程请求宿主代做系统交互 */
  onHostCall?: (method: 'openExternal' | 'openPath', args: unknown) => Promise<unknown>
  /**
   * 宿主上的能力注册表。子进程调用能力时由这里路由到真正的实现；
   * 省略表示该插件不能用能力。
   */
  capabilities?: () => { get<T>(name: string): T | undefined } | undefined
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
  private readonly handles = new Map<number, Record<string, unknown>>()
  private handleSeq = 0
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

  /** 当前已注册的方法；停止插件时按它逐个撤销 */
  methodNames(): string[] {
    return [...this.methods]
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
    this.handles.clear()
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
        // 插件在 apply 里注册的每个方法都已经先发过 `register`；这里的列表是汇总，
        // 只补漏，不能重复注册（重复会直接抛「重复注册 RPC 方法」）
        for (const method of message.methods) {
          if (this.methods.has(method)) continue
          this.registerMethod(method)
        }
        resolveReady(message.methods)
        return
      case 'failed':
        rejectReady(new Error(`${message.stage}：${message.message}`))
        return
      case 'register':
        if (this.methods.has(message.method)) return
        this.registerMethod(message.method)
        return
      case 'unregister':
        this.methods.delete(message.method)
        try {
          this.options.onUnregister?.(message.method)
        } catch (error) {
          this.options.onLog?.('warn', `注销 RPC ${message.method} 失败：${String(error)}`)
        }
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
      case 'host-call':
        void this.handleHostCall(message)
        return
      case 'cap-call':
        void this.handleCapCall(message)
        return
      case 'disposed':
        return
    }
  }

  /** 子进程的系统交互请求转发给宿主实现 */
  private async handleHostCall(message: Extract<WorkerToHost, { t: 'host-call' }>): Promise<void> {
    try {
      if (!this.options.onHostCall) throw new Error('宿主没有提供系统交互能力')
      const value = await this.options.onHostCall(message.method, message.args)
      this.post({ t: 'host-result', id: message.id, ok: true, value })
    } catch (error) {
      this.post({
        t: 'host-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 子进程的能力调用：路由到宿主侧的真实现，句柄按 id 记账 */
  private async handleCapCall(message: Extract<WorkerToHost, { t: 'cap-call' }>): Promise<void> {
    try {
      const value = await this.dispatchCap(message)
      this.post({ t: 'cap-result', id: message.id, ok: true, value })
    } catch (error) {
      this.post({
        t: 'cap-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async dispatchCap(message: Extract<WorkerToHost, { t: 'cap-call' }>): Promise<unknown> {
    const spec = CAPABILITY_BRIDGES[message.cap]
    if (!spec) throw new Error(`能力 ${message.cap} 不支持跨进程`)

    if (message.target !== undefined) {
      const handle = this.handles.get(message.target)
      if (!handle) throw new Error(`句柄 ${message.target} 已失效`)
      if (message.method === 'once') {
        const event = String(message.args)
        const once = handle.once as
          | ((name: string, listener: (...args: unknown[]) => void) => unknown)
          | undefined
        if (typeof once !== 'function') throw new Error('句柄不支持事件订阅')
        const sub = message.sub
        once.call(handle, event, (...args: unknown[]) => {
          if (sub !== undefined) this.post({ t: 'cap-event', sub, payload: args })
        })
        return undefined
      }
      const fn = handle[message.method]
      if (typeof fn !== 'function') throw new Error(`句柄没有方法 ${message.method}`)
      const args = this.revive(message.args) as unknown[]
      return await (fn as (...rest: unknown[]) => unknown).apply(handle, args)
    }

    const impl = this.options.capabilities?.()?.get<Record<string, unknown>>(message.cap)
    if (!impl) throw new Error(`宿主没有能力 ${message.cap}`)
    const fn = impl[message.method]
    if (typeof fn !== 'function') throw new Error(`能力 ${message.cap} 没有方法 ${message.method}`)
    const args = this.revive(message.args) as unknown[]
    const result = await (fn as (...rest: unknown[]) => unknown).apply(impl, args)
    return this.retainHandle(spec, result)
  }

  /** 把 {@link __micsSub} 占位换回真回调：宿主侧的回调要推回子进程 */
  private revive(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.revive(item))
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.__micsSub === 'number') {
        const sub = record.__micsSub
        return (...args: unknown[]) => {
          this.post({ t: 'cap-event', sub, payload: args })
        }
      }
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) out[key] = this.revive(item)
      return out
    }
    return value
  }

  /**
   * 返回值如果带方法，就当成句柄：记账 + 把只读字段拍平带过去。
   *
   * 只对登记过 `handle` 的能力这么做——否则普通对象会被误判。
   */
  private retainHandle(spec: CapabilityBridgeSpec, result: unknown): unknown {
    if (!spec.handle || !result || typeof result !== 'object') return result
    const id = ++this.handleSeq
    this.handles.set(id, result as Record<string, unknown>)
    const fields: Record<string, unknown> = {}
    for (const field of spec.handle.fields) {
      fields[field] = (result as Record<string, unknown>)[field]
    }
    return { __micsHandle: id, __micsFields: fields }
  }

  /**
   * 注册一个 RPC 方法。
   *
   * 宿主侧注册失败（例如同一个方法被注册两次）不能把主进程带崩：
   * 记一条日志，让插件自己表现为「方法不可用」。
   */
  private registerMethod(method: string): void {
    this.methods.add(method)
    try {
      this.options.onRegister?.(method)
    } catch (error) {
      this.options.onLog?.('warn', `注册 RPC ${method} 失败：${String(error)}`)
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
