import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context, Fiber, Plugin } from 'cordis'
import { Service } from 'cordis'
import {
  importPluginEntry,
  installPluginFromDirectory,
  readPluginDirectory,
  removePluginFiles,
  runUninstallScript,
  scanPlugins,
  UNINSTALL_TIMEOUT_MS,
} from '@mics/plugin-loader'
import type {
  Disposable,
  KernelConfig,
  PluginId,
  PluginInfo,
  PluginInstallSummary,
  PluginRecord,
  PluginState,
  PluginStatus,
  RuntimeSnapshot,
  StorageServiceApi,
} from '@mics/sdk'
import { PLUGIN_ID, PLUGIN_SCHEME } from '@mics/sdk'

/** 等插件真正停下来的上限；超过就认为它没救，交给失败态与用户重试 */
const STOP_TIMEOUT_MS = 10_000

interface Entry {
  record: PluginRecord
  state: PluginState
  error?: string
  fiber?: Fiber
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

async function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
 * 插件宿主服务：维护「已安装插件」这个集合，以及清单、状态与 fiber 的对应关系。
 *
 * 三态模型（安装目录是唯一事实来源）：
 *   - 已安装 + 未禁用 → enabled，代码在跑；
 *   - 已安装 + 在 disabled-plugins.json 里 → disabled，文件在、代码停；
 *   - 目录不存在 → 不在 entries 里，也就是「未安装」，界面上不会出现这一行。
 *
 * 内置插件（source === 'builtin'）可以禁用，但不可卸载；core / essential 连禁用也不行。
 *
 * 所有改变插件集合或开关的操作都串行执行：同一个插件排队，安装/卸载再全局排队，
 * 避免两次点击把状态机踩乱。
 */
export class PluginsService extends Service {
  static inject: string[] = []

  private readonly baseCtx: Context
  private readonly config: KernelConfig
  private readonly entries = new Map<PluginId, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly disabled = new Set<PluginId>()

  private readonly queues = new Map<PluginId, Promise<unknown>>()
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'plugins')
    this.baseCtx = ctx
    this.config = config
  }

  [Service.init](): void {
    for (const record of this.config.plugins) {
      const id = record.manifest.id
      this.entries.set(id, {
        record,
        state: id === this.config.kernel ? 'active' : 'discovered',
      })
    }

    // 禁用来源有两处：安装时写下的状态文件，以及部署时静态声明的 boot.config。
    for (const id of this.readDisabled()) this.disabled.add(id)
    for (const id of this.config.disabled) this.disabled.add(id)

    for (const [id, entry] of this.entries) {
      if (!this.disabled.has(id)) continue
      // core / essential 不允许禁用：宁可忽略记录，也不能把界面锁死
      if (this.isLocked(entry)) {
        this.disabled.delete(id)
        continue
      }
      entry.state = 'disabled'
    }

    this.persistDisabled()
    this.syncHost()
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

  activate(id: PluginId): Promise<void> {
    return this.serialize(id, () => this.doStart(this.require(id)))
  }

  /** 禁用：持久化 + 卸载，之后不会再被自动激活 */
  disable(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      if (this.isLocked(entry)) {
        throw new Error(
          entry.record.manifest.core
            ? `内核插件 ${id} 不可禁用`
            : `插件 ${id} 是必需插件，不可禁用`,
        )
      }

      this.disabled.add(id)
      this.persistDisabled()
      await this.stop(entry)
      entry.state = 'disabled'
      entry.error = undefined
      this.notify()
      this.baseCtx.emit('plugin/deactivated', id)
    })
  }

  /** 启用：解除禁用并激活 */
  enable(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      this.disabled.delete(id)
      this.persistDisabled()
      entry.error = undefined
      await this.doStart(entry)
      this.notify()
    })
  }

  /** 重载：停掉旧代码，重新导入并挂载；失败则标记为失败态 */
  reload(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      if (this.disabled.has(id)) throw new Error(`插件 ${id} 已禁用，请先启用再重载`)
      await this.stop(entry)
      entry.state = 'discovered'
      entry.error = undefined
      await this.doStart(entry)
      this.notify()
    })
  }

  /** 渲染端加载失败时回报：主进程这一半也要停下来，避免「一半在跑」 */
  fail(id: PluginId, message: string): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      await this.stop(entry)
      entry.state = 'failed'
      entry.error = message
      this.notify()
    })
  }

  /** 安装前预览：只读清单，不落盘 */
  async inspect(dir: string): Promise<PluginInstallSummary> {
    const result = await readPluginDirectory(dir, 'user', true)
    if (!result.record) throw new Error(result.errors.join('；') || '插件清单无效')
    const existing = this.entries.get(result.record.manifest.id)
    if (existing?.record.source === 'builtin') {
      throw new Error(`插件 id ${result.record.manifest.id} 属于内置插件，不能安装同名插件`)
    }
    return this.summarize(result.record, existing?.record.manifest.version)
  }

  /**
   * 从文件夹安装。
   *
   * 安装只负责「文件到位、登记」，装完一律是禁用状态——用户点启用才真正执行代码。
   */
  install(dir: string): Promise<{ plugin: PluginInstallSummary; upgraded: boolean }> {
    return this.exclusive(async () => {
      const preview = await this.inspect(dir)
      return this.serialize(preview.id, async () => {
        const existing = this.entries.get(preview.id)
        const wasActive = existing?.state === 'active' || existing?.state === 'activating'

        // 升级：先停旧版，再替换目录，最后保持禁用
        if (existing) await this.stop(existing)

        let installed
        try {
          installed = await installPluginFromDirectory({
            sourceDir: dir,
            pluginsDir: this.config.userPluginRoot,
            reservedIds: this.builtinIds(),
          })
        } catch (error) {
          // 替换失败时旧版本还在磁盘上：把它恢复到安装前的运行状态
          if (existing && wasActive) await this.doStart(existing).catch(() => {})
          throw error
        }

        this.disabled.add(installed.record.manifest.id)
        await this.rescan()
        return {
          plugin: this.summarize(installed.record, preview.installedVersion),
          upgraded: installed.upgraded,
        }
      })
    })
  }

  /**
   * 卸载：停用 → 卸载脚本 → 删本体与存储。
   *
   * 卸载脚本失败或超时（stage === 'script'）时插件保持禁用、目录保留，
   * 用户可以重试或强制卸载；删文件失败（stage === 'files'）则只能重试。
   */
  uninstall(id: PluginId, options: { force?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      return this.serialize(id, async () => {
        const entry = this.require(id)
        if (entry.record.source === 'builtin') {
          throw new Error(`内置插件 ${id} 不可卸载`)
        }

        // 先落禁用：即使后面失败，它也保持「已安装但已禁用」，不会自己跑起来
        this.disabled.add(id)
        this.persistDisabled()
        await this.stop(entry)
        entry.state = 'disabled'
        entry.error = undefined
        this.notify()

        if (!options.force) {
          await runUninstallScript(entry.record, {
            userDataDir: this.config.userDataDir,
            timeoutMs: UNINSTALL_TIMEOUT_MS,
            log: (message) => this.baseCtx.logger('plugins').info(message),
          })
        }

        await removePluginFiles(entry.record, this.config.userDataDir)
        this.disabled.delete(id)
        this.forgetStorage(id)
        await this.rescan()
      })
    })
  }

  // -------------------------------------------------------------------------
  // 内部：状态机与文件系统同步
  // -------------------------------------------------------------------------

  private require(id: PluginId): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未找到插件 ${id}`)
    return entry
  }

  private async doStart(entry: Entry, visiting: Set<PluginId> = new Set()): Promise<void> {
    const { manifest } = entry.record
    const id = manifest.id
    if (this.disabled.has(id)) {
      throw new Error(`插件 ${id} 已被禁用，请先在插件面板中启用`)
    }
    if (entry.state === 'active') return
    if (visiting.has(id)) throw new Error(`插件 ${id} 存在循环依赖`)

    const nextVisiting = new Set(visiting).add(id)
    this.setState(entry, 'activating')
    try {
      for (const dependency of manifest.dependencies ?? []) {
        const target = this.entries.get(dependency)
        if (!target) throw new Error(`插件 ${id} 依赖的 ${dependency} 未安装`)
        // 依赖走同一条启动路径，但不重复加锁：外层已经持有当前插件的锁，
        // 依赖之间出现环时由 visiting 直接报错，而不是互相等待。
        await this.doStart(target, nextVisiting)
      }

      if (entry.record.entryMain) {
        const module = await importPluginEntry(entry.record.entryMain)
        const plugin = resolvePlugin(module, id)
        // 每个插件拿到独立的子上下文，带上 pluginId：
        // 服务通过 pluginIdOf(ctx) 就能实现「按插件隔离」的存储、命令归属等
        const scope = this.baseCtx.extend({ [PLUGIN_ID]: id }) as Context
        entry.fiber = await scope.plugin(plugin, { pluginId: id, manifest })
      }

      entry.error = undefined
      this.setState(entry, 'active')
      this.baseCtx.emit('plugin/activated', id)
    } catch (error) {
      entry.error = toMessage(error)
      this.setState(entry, 'failed')
      this.baseCtx.logger('plugins').warn(`插件 ${id} 激活失败：${entry.error}`)
      throw error
    }
  }

  private async stop(entry: Entry): Promise<void> {
    const fiber = entry.fiber
    entry.fiber = undefined
    if (!fiber) return
    const id = entry.record.manifest.id
    try {
      await withTimeout(
        Promise.resolve(fiber.dispose()),
        STOP_TIMEOUT_MS,
        `插件 ${id} 停止超时（${STOP_TIMEOUT_MS}ms）`,
      )
    } catch (error) {
      this.baseCtx.logger('plugins').warn(`插件 ${id} 停止异常：${toMessage(error)}`)
    }
  }

  /**
   * 重新扫描两个根目录，把 entries 与磁盘对齐。
   *
   * 目录是「已安装」的唯一事实来源：目录消失就是卸载，目录出现就是安装。
   * 内置根排在前，所以第三方同 id 的目录会被当成冲突而不是覆盖。
   */
  private async rescan(): Promise<void> {
    const scan = await scanPlugins([
      ...this.config.pluginRoots.map((dir) => ({ dir, source: 'builtin' as const })),
      { dir: this.config.userPluginRoot, source: 'user' as const },
    ])
    for (const failure of scan.errors) {
      this.baseCtx.logger('plugins').warn(`跳过插件 ${failure.dir}：${failure.errors.join('; ')}`)
    }

    const next = new Map(scan.plugins.map((record) => [record.manifest.id, record]))

    // 目录消失：停掉并从列表里移除（重启后也不会再出现）
    for (const [id, entry] of [...this.entries]) {
      if (id === this.config.kernel || next.has(id)) continue
      await this.stop(entry)
      this.entries.delete(id)
      this.disabled.delete(id)
      this.forgetStorage(id)
    }

    // 目录出现或清单更新
    for (const [id, record] of next) {
      const entry = this.entries.get(id)
      if (entry) {
        entry.record = record
      } else {
        this.entries.set(id, {
          record,
          state: this.disabled.has(id) ? 'disabled' : 'discovered',
        })
      }
    }

    // 让状态与禁用集合对齐（升级后保持禁用、启用后不再显示禁用）
    for (const [id, entry] of this.entries) {
      if (id === this.config.kernel) continue
      if (this.disabled.has(id) && entry.state !== 'disabled') {
        await this.stop(entry)
        entry.state = 'disabled'
      } else if (!this.disabled.has(id) && entry.state === 'disabled') {
        entry.state = 'discovered'
      }
    }

    this.persistDisabled()
    this.syncHost()
    this.notify()
  }

  /** 把当前插件目录集合同步给宿主（协议映射），新装的插件才能被页面加载 */
  private syncHost(): void {
    if (!this.config.host) return
    const dirs: Record<PluginId, string> = {}
    for (const [id, entry] of this.entries) dirs[id] = entry.record.dir
    this.config.host.syncPluginDirs(dirs)
  }

  private builtinIds(): PluginId[] {
    return [...this.entries.values()]
      .filter((entry) => entry.record.source === 'builtin')
      .map((entry) => entry.record.manifest.id)
  }

  private forgetStorage(id: PluginId): void {
    const storage = this.baseCtx.get('storage') as
      | (StorageServiceApi & { forget?: (id: PluginId) => void })
      | undefined
    storage?.forget?.(id)
  }

  private summarize(record: PluginRecord, installedVersion?: string): PluginInstallSummary {
    const { manifest } = record
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      hasMain: Boolean(record.entryMain),
      hasRenderer: Boolean(record.entryRenderer),
      hasUninstall: Boolean(record.entryUninstall),
      installedVersion,
      warnings: [...record.warnings],
    }
  }

  /**
   * core / essential 是内置插件的保护标记。
   *
   * 第三方插件即使在自己的清单里写了这两个字段也不生效：否则任何插件都能
   * 宣告自己「必需」，从而把自己锁在启用态、拒绝卸载。
   */
  private isLocked(entry: Entry): boolean {
    if (entry.record.source !== 'builtin') return false
    return Boolean(entry.record.manifest.core || entry.record.manifest.essential)
  }

  private setState(entry: Entry, state: PluginState): void {
    entry.state = state
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
    this.baseCtx.emit('plugins/changed')
  }

  private statusOf(entry: Entry): PluginStatus {
    if (entry.state === 'disabled') return 'disabled'
    if (entry.state === 'failed') return 'failed'
    return 'enabled'
  }

  private describe(entry: Entry): PluginInfo {
    const { manifest, source } = entry.record
    const builtin = source === 'builtin'
    const renderer = manifest.renderer
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      state: entry.state,
      status: this.statusOf(entry),
      source,
      // 保护标记只对内置插件生效，见 isLocked()
      core: builtin && Boolean(manifest.core),
      essential: builtin && Boolean(manifest.essential),
      canDisable: !this.isLocked(entry),
      uninstallable: !builtin,
      hasUninstall: Boolean(entry.record.entryUninstall),
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

  // -------------------------------------------------------------------------
  // 串行化
  // -------------------------------------------------------------------------

  /** 同一个插件的生命周期操作排队执行 */
  private serialize<T>(id: PluginId, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const settled = run.catch(() => {})
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return run
  }

  /** 安装 / 卸载这类改动整个插件集合的操作全局排队 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => {}).then(task)
    this.mutations = next.catch(() => {})
    return next
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

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
