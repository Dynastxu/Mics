import { spawn, type ChildProcess } from 'node:child_process'
import type {
  InstanceLaunchState,
  LaunchPhase,
  LaunchProcessInfo,
  LaunchState,
} from './shared'

interface ProcessRecord extends LaunchProcessInfo {
  instanceId: string
  child?: ChildProcess
}

/** 持久化到插件存储的形态：不含 ChildProcess，重启后按 pid 重新认领 */
export interface PersistedProcess {
  instanceId: string
  pid: number
  startedAt: number
  phase: LaunchPhase
}

export interface LaunchRuntimeOptions {
  /** 读取上次退出前留下的进程记录 */
  load(): unknown
  /** 运行状态变化时写回存储 */
  save(records: PersistedProcess[]): void
  /** 广播新的状态快照 */
  publish(state: LaunchState): void
}

const PRUNE_INTERVAL = 5_000

/** pid 是否仍然存活；EPERM 说明进程存在但当前身份拿不到信号权限 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 结束进程树：Minecraft 自己不会再拉起子进程，但 java 启动器可能 */
export function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve()

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      child.once('error', () => resolve())
      child.once('exit', () => resolve())
    })
  }

  const signal = (value: NodeJS.Signals): void => {
    try {
      process.kill(-pid, value)
    } catch {
      try {
        process.kill(pid, value)
      } catch { /* 进程已经退出 */ }
    }
  }

  signal('SIGTERM')
  return new Promise((resolve) => {
    setTimeout(() => {
      signal('SIGKILL')
      resolve()
    }, 3_000)
  })
}

/**
 * 已启动实例的进程表。
 *
 * - 同一实例可能因为「仍要启动」而同时有多个进程，因此按 pid 记录；
 * - 状态变化（开始启动 / 窗口出现 / 进程退出）都会写回存储并广播；
 * - 应用重启后从存储恢复仍存活的 pid，保证「终止进程」依然可用。
 */
export class LaunchRuntime {
  private readonly records = new Map<number, ProcessRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly options: LaunchRuntimeOptions) {}

  /** 恢复上次运行的进程并开始巡检；只保留仍存活的 pid */
  restore(): void {
    if (this.timer) return

    const stored = this.options.load()
    if (Array.isArray(stored)) {
      for (const value of stored as PersistedProcess[]) {
        if (!value || typeof value !== 'object') continue
        const pid = Number(value.pid)
        const instanceId = typeof value.instanceId === 'string' ? value.instanceId : ''
        if (!instanceId || !Number.isInteger(pid) || pid <= 0 || this.records.has(pid)) continue
        if (!isProcessAlive(pid)) continue
        this.records.set(pid, {
          instanceId,
          pid,
          startedAt: Number(value.startedAt) || Date.now(),
          phase: 'running',
        })
      }
    }

    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL)
    this.emit()
  }

  /** 登记一次刚 spawn 的游戏进程，进入「启动中」 */
  add(instanceId: string, pid: number, child: ChildProcess): void {
    if (this.disposed || !Number.isInteger(pid) || pid <= 0 || this.records.has(pid)) return

    const record: ProcessRecord = {
      instanceId,
      pid,
      startedAt: Date.now(),
      phase: 'starting',
      child,
    }
    this.records.set(pid, record)

    const forget = (): void => this.remove(pid)
    child.once('exit', forget)
    child.once('error', forget)

    this.emit()
  }

  /** 游戏窗口已经出现（或探测超时兜底），按钮可以从「启动中」恢复 */
  markRunning(pid: number): void {
    const record = this.records.get(pid)
    if (!record || record.phase === 'running') return
    record.phase = 'running'
    this.emit()
  }

  remove(pid: number): void {
    if (!this.records.delete(pid)) return
    this.emit()
  }

  hasPid(pid: number): boolean {
    return this.records.has(pid)
  }

  pidsOf(instanceId: string): number[] {
    return [...this.records.values()]
      .filter((record) => record.instanceId === instanceId)
      .map((record) => record.pid)
  }

  snapshot(): LaunchState {
    const grouped = new Map<string, LaunchProcessInfo[]>()
    for (const record of this.records.values()) {
      const list = grouped.get(record.instanceId) ?? []
      list.push({
        pid: record.pid,
        startedAt: record.startedAt,
        phase: record.phase,
      })
      grouped.set(record.instanceId, list)
    }

    const instances: InstanceLaunchState[] = [...grouped.entries()].map(([id, processes]) => ({
      id,
      processes: processes.sort((a, b) => a.startedAt - b.startedAt),
    }))
    return { instances }
  }

  /** 终止该实例的全部进程（也用于在「启动中」阶段取消） */
  async terminate(instanceId: string): Promise<number> {
    const pids = this.pidsOf(instanceId)
    await Promise.all(pids.map((pid) => terminateProcessTree(pid)))

    // 结束成功（或本来就已经退出）才摘掉记录；kill 失败时保留，界面上仍可重试。
    let removed = 0
    for (const pid of pids) {
      if (!this.records.has(pid) || isProcessAlive(pid)) continue
      this.records.delete(pid)
      removed += 1
    }
    if (removed > 0) this.emit()
    return removed
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 巡检：清掉已经退出、但没来得及触发 exit 事件的记录（例如重启前遗留） */
  private prune(): void {
    let changed = false
    for (const pid of [...this.records.keys()]) {
      if (isProcessAlive(pid)) continue
      this.records.delete(pid)
      changed = true
    }
    if (changed) this.emit()
  }

  private emit(): void {
    if (this.disposed) return
    this.options.save(this.persisted())
    this.options.publish(this.snapshot())
  }

  private persisted(): PersistedProcess[] {
    return [...this.records.values()].map((record) => ({
      instanceId: record.instanceId,
      pid: record.pid,
      startedAt: record.startedAt,
      phase: record.phase,
    }))
  }
}
