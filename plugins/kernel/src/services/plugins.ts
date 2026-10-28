import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context, Fiber, Plugin } from 'cordis'
import { Service } from 'cordis'
import { importPluginEntry } from '@mics/plugin-loader'
import type {
  Disposable,
  KernelConfig,
  PluginId,
  PluginInfo,
  PluginRecord,
  PluginState,
  RuntimeSnapshot,
} from '@mics/sdk'
import { PLUGIN_ID, PLUGIN_SCHEME } from '@mics/sdk'

interface Entry {
  record: PluginRecord
  state: PluginState
  error?: string
  fiber?: Fiber
  task?: Promise<void>
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

/** 从插件入口模块里取出 cordis 插件对象 */
function resolvePlugin(
  module: Record<string, unknown>,
  id: PluginId,
): import('cordis').Plugin.Object<unknown> {
  const candidate = module.default ?? module
  if (typeof candidate === 'function') {
    return candidate as unknown as import('cordis').Plugin.Object<unknown>
  }
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as { apply?: unknown }).apply === 'function'
  ) {
    return candidate as unknown as import('cordis').Plugin.Object<unknown>
  }
  throw new Error(`插件 ${id} 没有导出 cordis 插件（需要 default 或 apply）`)
}

/**
 * 插件宿主服务：维护清单、状态与 cordis fiber 的对应关系。
 *
 * 每个插件都会被 `ctx.plugin()` 挂到底座上，卸载即 dispose 对应 fiber，
 * 插件里通过 ctx.effect 注册的一切都会自动回收。
 *
 * 禁用是「持久化」的：写入 userData/disabled-plugins.json，
 * 之后无论页面打开、命令执行还是启动事件都不会再激活它，只有 enable() 能解除。
 */
export class PluginsService extends Service {
  static inject: string[] = []

  private readonly baseCtx: Context
  private readonly config: KernelConfig
  private readonly entries = new Map<PluginId, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly disabled = new Set<PluginId>()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'plugins')
    this.baseCtx = ctx
    this.config = config
  }

  [Service.init](): void {
    for (const record of this.config.plugins) {
      const id = record.manifest.id
      // 必需插件必须始终出现在插件管理里，否则用户没有入口把它启用回来
      if (this.config.disabled.includes(id) && !record.manifest.essential) continue
      this.entries.set(id, {
        record,
        state: id === this.config.kernel ? 'active' : 'discovered',
      })
    }

    for (const id of this.readDisabled()) {
      const entry = this.entries.get(id)
      if (!entry) continue
      if (this.isUndeletable(entry)) continue
      this.disabled.add(id)
      entry.state = 'disabled'
    }
    this.persistDisabled()
  }

  list(): PluginInfo[] {
    return [...this.entries.values()].map((entry) => this.describe(entry))
  }

  get(id: PluginId): PluginInfo | undefined {
    const entry = this.entries.get(id)
    return entry ? this.describe(entry) : undefined
  }

  snapshot(): RuntimeSnapshot {
    return { app: this.config.app, plugins: this.list(), commands: [] }
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 激活所有声明了 * / onStartup 的插件；被禁用的插件会跳过 */
  async activateStartup(): Promise<void> {
    const startup = [...this.entries.values()].filter((entry) => {
      if (this.disabled.has(entry.record.manifest.id)) return false
      const activation = entry.record.manifest.activation ?? []
      return activation.includes('*') || activation.includes('onStartup')
    })
    await Promise.allSettled(
      startup.map((entry) => this.activate(entry.record.manifest.id)),
    )
  }

  async activate(id: PluginId): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未找到插件 ${id}`)
    if (this.disabled.has(id)) {
      throw new Error(`插件 ${id} 已被禁用，请先在插件面板中启用`)
    }
    if (entry.state === 'active') return
    if (entry.task) return entry.task
    const task = this.doActivate(entry).finally(() => {
      entry.task = undefined
    })
    entry.task = task
    return task
  }

  /** 禁用：持久化 + 卸载，之后不会再被自动激活 */
  async disable(id: PluginId): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未找到插件 ${id}`)
    if (entry.record.manifest.core) {
      throw new Error(`内核插件 ${id} 不可禁用`)
    }
    if (entry.record.manifest.essential) {
      throw new Error(`插件 ${id} 是必需插件，不可禁用`)
    }
    this.disabled.add(id)
    this.persistDisabled()
    await this.stop(entry)
    entry.state = 'disabled'
    this.notify()
    this.baseCtx.emit('plugin/deactivated', id)
  }

  /** 启用：解除禁用并激活 */
  async enable(id: PluginId): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未找到插件 ${id}`)
    if (!this.disabled.has(id)) return
    this.disabled.delete(id)
    this.persistDisabled()
    this.notify()
    await this.activate(id)
  }

  /** core 与 essential 都不允许禁用；后者用于插件管理这类自锁风险插件 */
  private isUndeletable(entry: Entry): boolean {
    return Boolean(entry.record.manifest.core || entry.record.manifest.essential)
  }

  private async stop(entry: Entry): Promise<void> {
    if (entry.task) {
      await entry.task.catch(() => {})
      entry.task = undefined
    }
    if (entry.fiber) {
      await entry.fiber.dispose()
      entry.fiber = undefined
    }
  }

  private async doActivate(entry: Entry): Promise<void> {
    const { manifest } = entry.record
    const id = manifest.id
    if (entry.state === 'active' || entry.state === 'activating') return
    if (this.disabled.has(id)) throw new Error(`插件 ${id} 已被禁用`)
    this.setState(entry, 'activating')
    try {
      for (const dependency of manifest.dependencies ?? []) {
        await this.activate(dependency)
      }
      if (entry.record.entryMain) {
        const module = await importPluginEntry(entry.record.entryMain)
        const plugin = resolvePlugin(module, id)
        // 每个插件拿到独立的子上下文，带上 pluginId：
        // 服务通过 pluginIdOf(ctx) 就能实现「按插件隔离」的存储、命令归属等
        const scope = this.baseCtx.extend({ [PLUGIN_ID]: id }) as Context
        entry.fiber = await scope.plugin(plugin, { pluginId: id, manifest })
      }
      this.setState(entry, 'active')
      this.baseCtx.emit('plugin/activated', id)
    } catch (error) {
      entry.error = toMessage(error)
      this.setState(entry, 'failed')
      this.baseCtx.logger('plugins').warn(`插件 ${id} 激活失败：${entry.error}`)
      throw error
    }
  }

  private setState(entry: Entry, state: PluginState): void {
    entry.state = state
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
    this.baseCtx.emit('plugins/changed')
  }

  private describe(entry: Entry): PluginInfo {
    const { manifest } = entry.record
    const renderer = manifest.renderer
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      state: entry.state,
      core: manifest.core ?? false,
      essential: manifest.essential ?? false,
      manifest,
      hasMain: Boolean(entry.record.entryMain),
      hasRenderer: Boolean(entry.record.entryRenderer),
      rendererUrl: renderer
        ? `${PLUGIN_SCHEME}://${manifest.id}/${encodePath(renderer)}`
        : undefined,
      styles: (manifest.styles ?? []).map(
        (style) => `${PLUGIN_SCHEME}://${manifest.id}/${encodePath(style)}`,
      ),
      error: entry.error,
    }
  }

  private disabledFile(): string {
    return path.join(this.config.userDataDir, 'disabled-plugins.json')
  }

  private readDisabled(): PluginId[] {
    try {
      const parsed = JSON.parse(readFileSync(this.disabledFile(), 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  private persistDisabled(): void {
    try {
      mkdirSync(path.dirname(this.disabledFile()), { recursive: true })
      writeFileSync(this.disabledFile(), JSON.stringify([...this.disabled], null, 2), 'utf8')
    } catch (error) {
      this.baseCtx.logger('plugins').warn(`保存禁用列表失败：${toMessage(error)}`)
    }
  }
}
