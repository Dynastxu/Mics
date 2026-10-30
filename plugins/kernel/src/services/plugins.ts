import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  CapabilitiesServiceApi,
  CommandsServiceApi,
  Disposable,
  IpcServiceApi,
  KernelConfig,
  PluginDependencyDetail,
  PluginDependencyRef,
  PluginFailure,
  PluginFailureStage,
  PluginGraphNode,
  PluginGraphReport,
  PluginId,
  PluginInfo,
  PluginInstallSummary,
  PluginRecord,
  PluginState,
  PluginStatus,
  PluginUnmetRef,
  ProfileLock,
  RuntimeSnapshot,
  ScanError,
  StorageServiceApi,
} from '@mics/sdk'
import {
  bailEvent,
  emitEvent,
  FIBER_ACTIVE,
  FIBER_FAILED,
  FIBER_PENDING,
  PLUGIN_ID,
  PLUGIN_SCHEME,
  PluginFailureError,
  PluginUninstallError,
  pluginIdOf,
} from '@mics/sdk'
import {
  reportIpcRegistrations,
  snapshotIpcRegistrations,
  type IpcRegistrationSnapshot,
} from '../cleanupAudit'

/** 等插件真正停下来的上限；超过就认为它没救，交给失败态与用户重试 */
const STOP_TIMEOUT_MS = 10_000

interface Entry {
  record: PluginRecord
  state: PluginState
  failure?: PluginFailure
  /** 停止超时过：旧代码可能仍在跑，重启应用前拒绝再次激活 */
  restartRequired?: boolean
  fiber?: Fiber
  /** 清单依赖的问题（缺失 / 自依赖 / 循环），激活前就能确定 */
  issues?: string[]
  /** 正在等待的服务名，只在 state === 'waiting' 时有值 */
  waitingFor?: string[]
  /** 本次激活开始的时间；用于日志里的耗时 */
  startedAt?: number
}

/** 能力注册表里只给内核用的生命周期钩子 */
type CapabilitiesDiagnostics = CapabilitiesServiceApi & { forget?: (id: PluginId) => void }

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
  /** 生效的禁用集合（boot.config + 用户开关 + profile，按优先级合并） */
  private readonly disabled = new Set<PluginId>()
  /** 用户自己切换出来的禁用集合；持久化到 disabled-plugins.json */
  private readonly userDisabled = new Set<PluginId>()
  /** 最近一次扫描里失败的目录；清单非法时插件不会进入 entries，只能从这里看到 */
  private scanIssues: ScanError[] = []

  private readonly queues = new Map<PluginId, Promise<unknown>>()
  /** 同一个插件同时只跑一次启动；共享给并发的依赖方 */
  private readonly starting = new Map<PluginId, Promise<void>>()
  /** dev 清理审计：每个插件上一次重载后的 ipcMain 注册快照 */
  private readonly ipcAuditBaselines = new Map<PluginId, IpcRegistrationSnapshot>()
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: KernelConfig) {
    super(ctx, 'plugins')
    this.baseCtx = ctx
    this.config = config
  }

  [Service.init](): void {
    this.scanIssues = [...(this.config.scanErrors ?? [])]
    for (const record of this.config.plugins) {
      const id = record.manifest.id
      this.entries.set(id, {
        record,
        state: id === this.config.kernel ? 'active' : 'discovered',
      })
    }

    // 禁用来源：用户开关（文件）、部署静态声明、以及 profile 的强制集合。
    // 用户集合单独保存，profile 变化时只需要重新合并，不会污染用户选择。
    for (const id of this.readDisabled()) this.userDisabled.add(id)
    this.rebuildEffectiveDisabled()

    for (const [id, entry] of this.entries) {
      if (!this.disabled.has(id)) continue
      // core / essential 不允许禁用：宁可忽略记录，也不能把界面锁死
      if (this.isLocked(entry)) {
        this.disabled.delete(id)
        this.userDisabled.delete(id)
        continue
      }
      entry.state = 'disabled'
    }

    this.validateGraph()
    const log = this.baseCtx.logger('plugins')
    for (const [id, entry] of this.entries) {
      if (!entry.issues?.length) continue
      log.warn(`插件 ${id} 的依赖有问题：${entry.issues.join('；')}`)
    }

    const builtin = [...this.entries.values()].filter(
      (entry) => entry.record.source === 'builtin',
    ).length
    log.info(
      '插件目录已就绪：共 %d 个（内置 %d，第三方 %d），禁用 %d 个',
      this.entries.size,
      builtin,
      this.entries.size - builtin,
      this.disabled.size,
    )
    if (this.disabled.size > 0) {
      log.info('已禁用的插件：%s', [...this.disabled].sort().join('、'))
    }
    if (this.scanIssues.length > 0) {
      log.warn('有 %d 个插件目录未能加载，详见启动日志与插件诊断', this.scanIssues.length)
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

  /**
   * 依赖图 + 贡献点 + 未满足项。
   *
   * 数据全部来自内核已经持有的注册表，不再让界面自己猜：
   *   - `dependsOn`：清单依赖 + 非内核服务提供方 + 能力提供方；
   *   - `dependents`：上面这张图的反向边；
   *   - `provides`：fiber 注册的服务 + `capabilities` 里的提供方；
   *   - `contributes`：RPC、命令、页面、主题、状态栏；
   *   - `unmet`：装了但没开、开了但没人提供、能力没有 provider。
   */
  diagnostics(): PluginGraphReport {
    const nodes = new Map<PluginId, PluginGraphNode>()
    for (const entry of this.entries.values()) {
      const info = this.describe(entry)
      nodes.set(info.id, {
        id: info.id,
        name: info.name,
        version: info.version,
        status: info.status,
        state: info.state,
        source: info.source,
        failure: entry.failure,
        restartRequired: entry.restartRequired,
        dependsOn: [],
        dependents: [],
        provides: [],
        consumes: [],
        contributes: [],
        warnings: [...entry.record.warnings],
      })
    }

    const ipc = this.baseCtx.get('ipc') as IpcServiceApi | undefined
    const commands = this.baseCtx.get('commands') as CommandsServiceApi | undefined
    const capabilities = this.baseCtx.get('capabilities') as CapabilitiesServiceApi | undefined
    const commandList = commands?.list() ?? []
    const capabilityNames = capabilities?.names() ?? []
    const unmet = new Map<string, PluginUnmetRef>()
    const addUnmet = (kind: PluginUnmetRef['kind'], name: string, id: PluginId): void => {
      const key = `${kind}:${name}`
      const ref = unmet.get(key) ?? { kind, name, neededBy: [] }
      if (!ref.neededBy.includes(id)) ref.neededBy.push(id)
      unmet.set(key, ref)
    }

    const addDependency = (
      node: PluginGraphNode,
      targetId: PluginId,
      detail: PluginDependencyDetail,
    ): void => {
      let ref: PluginDependencyRef | undefined = node.dependsOn.find(
        (item) => item.id === targetId,
      )
      if (!ref) {
        const target = nodes.get(targetId)
        ref = {
          id: targetId,
          name: target?.name ?? targetId,
          status: target?.status,
          satisfied: true,
          details: [],
        }
        node.dependsOn.push(ref)
      }
      ref.satisfied &&= detail.satisfied
      ref.details.push(detail)
    }

    for (const [id, entry] of this.entries) {
      const node = nodes.get(id)
      if (!node) continue

      for (const dependency of entry.record.manifest.dependencies ?? []) {
        const targetEntry = this.entries.get(dependency)
        if (!targetEntry) {
          addUnmet('plugin', dependency, id)
          addDependency(node, dependency, { kind: 'manifest', satisfied: false })
          continue
        }
        addDependency(node, dependency, {
          kind: 'manifest',
          satisfied: targetEntry.state !== 'disabled' && targetEntry.state !== 'failed',
        })
      }

      for (const name of Object.keys(entry.fiber?.inject ?? {})) {
        const impl = this.baseCtx.reflect._getImpl(name)
        const providerId = impl ? pluginIdOf(impl.ctx) : undefined
        const satisfied = impl !== undefined
        node.consumes.push({ kind: 'service', name, providerId, satisfied })
        if (!satisfied) addUnmet('service', name, id)
        if (providerId && providerId !== this.config.kernel && providerId !== id) {
          addDependency(node, providerId, { kind: 'service', via: name, satisfied })
        }
      }

      for (const name of capabilities?.consumersOf(id) ?? []) {
        const providers = capabilities?.providers(name) ?? []
        const providerId = providers[0]?.pluginId
        const satisfied = providers.length > 0
        node.consumes.push({ kind: 'capability', name, providerId, satisfied })
        if (!satisfied) addUnmet('capability', name, id)
        if (providerId && providerId !== this.config.kernel && providerId !== id) {
          addDependency(node, providerId, { kind: 'capability', via: name, satisfied })
        }
      }

      const provided = new Set<string>()
      for (const provision of entry.fiber?.provisions ?? []) {
        if (provided.has(provision.name)) continue
        provided.add(provision.name)
        node.provides.push({ kind: 'service', name: provision.name })
      }
      // 子 fiber 里注册的服务（内核的 plugins/ipc/… 就是这样挂的）不在
      // 插件自己的 provisions 里，用服务名反查提供方补齐。
      for (const name of Object.keys(this.baseCtx.reflect.props)) {
        if (provided.has(name)) continue
        if (this.baseCtx.reflect.props[name]?.type !== 'service') continue
        const impl = this.baseCtx.reflect._getImpl(name)
        if (!impl || pluginIdOf(impl.ctx) !== id) continue
        provided.add(name)
        node.provides.push({ kind: 'service', name })
      }
      for (const name of capabilityNames) {
        for (const provider of capabilities?.providers(name) ?? []) {
          if (provider.pluginId !== id) continue
          node.provides.push({
            kind: 'capability',
            name,
            label: provider.label,
            priority: provider.priority,
          })
        }
      }

      const declaredCommands = new Set<string>()
      for (const contributor of entry.record.manifest.contributes?.commands ?? []) {
        declaredCommands.add(contributor.id)
        node.contributes.push({ kind: 'command', id: contributor.id, title: contributor.title })
      }
      for (const contributor of commandList) {
        if (contributor.pluginId !== id || declaredCommands.has(contributor.id)) continue
        node.contributes.push({
          kind: 'command',
          id: contributor.id,
          title: contributor.title,
        })
      }
      for (const method of ipc?.methodsOf?.(id) ?? []) {
        node.contributes.push({ kind: 'rpc', id: method })
      }
      for (const nav of entry.record.manifest.contributes?.nav ?? []) {
        node.contributes.push({ kind: 'view', id: nav.id, title: nav.title })
      }
      for (const group of entry.record.manifest.contributes?.navGroups ?? []) {
        node.contributes.push({ kind: 'navGroup', id: group.id, title: group.title })
      }
      for (const item of entry.record.manifest.contributes?.statusBar ?? []) {
        node.contributes.push({ kind: 'statusBar', id: item.id, title: item.text })
      }
      for (const theme of entry.record.manifest.contributes?.themes ?? []) {
        node.contributes.push({ kind: 'theme', id: theme.id, title: theme.label })
      }
      const layout = entry.record.manifest.contributes?.layout
      if (layout) node.contributes.push({ kind: 'layout', id: layout.id, title: layout.label })
      const configuration = entry.record.manifest.contributes?.configuration
      if (configuration) {
        node.contributes.push({
          kind: 'configuration',
          id: 'configuration',
          title: configuration.title,
        })
      }
    }

    const byName = (a: { name: string }, b: { name: string }): number =>
      a.name.localeCompare(b.name)
    for (const node of nodes.values()) {
      for (const dependency of node.dependsOn) {
        const target = nodes.get(dependency.id)
        if (!target) continue
        target.dependents.push({
          id: node.id,
          name: node.name,
          status: node.status,
          satisfied: dependency.satisfied,
          details: dependency.details.map((detail) => ({ ...detail })),
        })
      }
      node.dependsOn.sort(byName)
      node.dependents.sort(byName)
      node.provides.sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      )
      node.consumes.sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      )
      node.contributes.sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
      )
    }

    return {
      generatedAt: Date.now(),
      kernel: this.config.kernel,
      profile: this.config.profile?.name,
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      unmet: [...unmet.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      ),
      scanIssues: [...this.scanIssues],
    }
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 激活所有声明了 * / onStartup 的插件；被禁用的插件会跳过 */
  async activateStartup(): Promise<void> {
    const log = this.baseCtx.logger('plugins')
    const startup = [...this.entries.values()].filter((entry) => {
      if (this.disabled.has(entry.record.manifest.id)) return false
      const activation = entry.record.manifest.activation ?? []
      return activation.includes('*') || activation.includes('onStartup')
    })
    if (startup.length === 0) {
      log.info('没有需要随启动激活的插件')
      return
    }

    log.info(
      '开始激活启动插件（%d 个）：%s',
      startup.length,
      startup.map((entry) => entry.record.manifest.id).join('、'),
    )
    const results = await Promise.allSettled(
      startup.map((entry) => this.activate(entry.record.manifest.id)),
    )
    const failed = results.filter((result) => result.status === 'rejected').length
    const waiting = [...this.entries.values()].filter((entry) => entry.state === 'waiting').length
    log.info(
      '启动插件激活完成：成功 %d，失败 %d，等待依赖 %d',
      results.length - failed,
      failed,
      waiting,
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

      const lock = this.profileLocked(id)
      if (lock === 'enabled') {
        throw new Error(`profile ${this.config.profile?.name} 强制启用插件 ${id}，不能禁用`)
      }

      this.userDisabled.add(id)
      this.rebuildEffectiveDisabled()
      this.persistDisabled()
      const timedOut = await this.stop(entry)
      if (timedOut) {
        // 停不下来就不能说「已禁用」：保留 failed + timeout，用户重试或重启应用
        this.setState(entry, 'failed')
        throw new PluginFailureError(
          'timeout',
          entry.failure?.message ?? `插件 ${id} 停止超时`,
        )
      }
      entry.state = 'disabled'
      entry.failure = undefined
      this.notify()
      emitEvent(this.baseCtx, 'plugin/deactivated', id)
      this.baseCtx.logger('plugins').info('插件 %s 已禁用', id)
    })
  }

  /** 启用：解除禁用并激活 */
  enable(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      if (this.profileLocked(id) === 'disabled') {
        throw new Error(`profile ${this.config.profile?.name} 禁用了插件 ${id}，不能启用`)
      }
      this.userDisabled.delete(id)
      this.rebuildEffectiveDisabled()
      this.persistDisabled()
      entry.failure = undefined
      await this.doStart(entry)
      this.notify()
      this.baseCtx.logger('plugins').info('插件 %s 已启用', id)
    })
  }

  /** 重载：停掉旧代码，重新导入并挂载；失败则标记为失败态 */
  reload(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      if (this.disabled.has(id)) throw new Error(`插件 ${id} 已禁用，请先启用再重载`)
      const log = this.baseCtx.logger('plugins')
      log.info('正在重载插件 %s', id)
      // 只在 dev 记录 ipcMain 注册；第一次重载建立基线，第二次开始比较
      const audit = this.config.app.isDev ? snapshotIpcRegistrations() : undefined
      try {
        const timedOut = await this.stop(entry)
        if (timedOut) {
          this.setState(entry, 'failed')
          throw new PluginFailureError(
            'timeout',
            entry.failure?.message ?? `插件 ${id} 停止超时`,
          )
        }
        entry.state = 'discovered'
        entry.failure = undefined
        await this.doStart(entry)
        this.notify()
        log.info('插件 %s 已重载', id)
      } finally {
        if (audit) {
          const current = snapshotIpcRegistrations()
          reportIpcRegistrations(
            id,
            this.ipcAuditBaselines.get(id),
            current,
            (message) => this.baseCtx.logger('cleanup').warn(message),
          )
          this.ipcAuditBaselines.set(id, current)
        }
      }
    })
  }

  /** 渲染端加载失败时回报：主进程这一半也要停下来，避免「一半在跑」 */
  fail(id: PluginId, message: string, stage: PluginFailureStage = 'renderer'): Promise<void> {
    return this.serialize(id, async () => {
      const entry = this.require(id)
      const timedOut = await this.stop(entry)
      entry.failure = timedOut
        ? {
            stage: 'timeout',
            message: `页面加载失败：${message}（主进程停止也超时，需要重启应用）`,
            at: Date.now(),
          }
        : { stage, message, at: Date.now() }
      this.setState(entry, 'failed')
      this.baseCtx.logger('plugins').warn('渲染端加载插件 %s 失败：%s', id, message)
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
   * 安装只负责「文件到位、登记」，装完默认是禁用状态——用户点启用才真正执行代码。
   * 若 profile.enable 强制启用了这个 id，则按 profile 的集合生效（仍要等第一次激活）。
   */
  install(dir: string): Promise<{ plugin: PluginInstallSummary; upgraded: boolean }> {
    return this.exclusive(async () => {
      const preview = await this.inspect(dir)
      return this.serialize(preview.id, async () => {
        const existing = this.entries.get(preview.id)
        const wasActive = existing?.state === 'active' || existing?.state === 'activating'

        // 升级：先停旧版，再替换目录，最后保持禁用
        if (existing) {
          if (existing.restartRequired) {
            throw new PluginFailureError(
              'timeout',
              `插件 ${preview.id} 上次停止超时，重启应用后才能替换文件`,
            )
          }
          const timedOut = await this.stop(existing)
          if (timedOut) {
            this.setState(existing, 'failed')
            throw new PluginFailureError(
              'timeout',
              existing.failure?.message ?? `插件 ${preview.id} 停止超时，无法替换文件`,
            )
          }
        }

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
          this.baseCtx
            .logger('plugins')
            .warn('安装插件 %s 失败：%s', preview.id, toMessage(error))
          throw error
        }

        this.userDisabled.add(installed.record.manifest.id)
        this.rebuildEffectiveDisabled()
        await this.rescan()
        const summary = this.summarize(installed.record, preview.installedVersion)
        this.baseCtx
          .logger('plugins')
          .info(
            installed.upgraded
              ? '插件 %s 已升级到 v%s（保持禁用，需手动启用）'
              : '插件 %s v%s 已安装（默认禁用）',
            summary.id,
            summary.version,
          )
        return {
          plugin: summary,
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
        this.userDisabled.add(id)
        this.rebuildEffectiveDisabled()
        this.persistDisabled()
        const log = this.baseCtx.logger('plugins')
        log.info('正在卸载插件 %s%s', id, options.force ? '（跳过卸载脚本）' : '')
        const timedOut = await this.stop(entry)
        if (timedOut) {
          this.setState(entry, 'failed')
          // 用 script 阶段复用「重试 / 强制卸载」的恢复路径：旧代码没停，
          // 此时删目录只会得到一个文件占用错误
          throw new PluginUninstallError(
            entry.failure?.message ?? `插件 ${id} 停止超时，无法卸载`,
            'script',
          )
        }
        entry.state = 'disabled'
        entry.failure = undefined
        this.notify()

        if (!options.force) {
          await runUninstallScript(entry.record, {
            userDataDir: this.config.userDataDir,
            timeoutMs: UNINSTALL_TIMEOUT_MS,
            log: (message) => this.baseCtx.logger('plugins').info(message),
          })
        }

        await removePluginFiles(entry.record, this.config.userDataDir)
        this.userDisabled.delete(id)
        this.disabled.delete(id)
        this.forgetStorage(id)
        await this.rescan()
        log.info('插件 %s 已卸载', id)
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

  /**
   * 启动一个插件（必要时先启动它声明的依赖）。
   *
   * 同一个插件可能被多条链同时要求启动（两个开机插件依赖同一个插件），
   * 因此用 `starting` 共享同一次启动，而不是重复挂载出第二个 fiber；
   * 依赖成环由 `visiting` 在进入前拦住。
   */
  private doStart(entry: Entry, visiting: Set<PluginId> = new Set()): Promise<void> {
    const { manifest } = entry.record
    const id = manifest.id

    if (visiting.has(id)) {
      return Promise.reject(new PluginFailureError('dependency', `插件 ${id} 存在循环依赖`))
    }
    if (this.disabled.has(id)) {
      return Promise.reject(new Error(`插件 ${id} 已被禁用，请先在插件面板中启用`))
    }
    if (entry.restartRequired) {
      // 旧 fiber 的 dispose 没结束：再启动会得到第二个 fiber，只能重启应用
      const failure = new PluginFailureError(
        'timeout',
        `插件 ${id} 上次停止超时，请重启应用后再操作`,
      )
      this.recordFailure(entry, failure)
      return Promise.reject(failure)
    }
    if (entry.issues?.length) {
      const failure = new PluginFailureError(
        'dependency',
        `插件 ${id} 的依赖有问题：${entry.issues.join('；')}`,
      )
      this.recordFailure(entry, failure)
      return Promise.reject(failure)
    }
    if (entry.state === 'active' || entry.state === 'waiting') return Promise.resolve()

    const running = this.starting.get(id)
    if (running) return running

    // 审批是同步投票：策略插件可以拒绝激活，拒绝结论会进入失败态
    let verdict: ReturnType<typeof bailEvent<'plugin/beforeActivate'>>
    try {
      verdict = bailEvent(this.baseCtx, 'plugin/beforeActivate', id)
    } catch (error) {
      const failure = new PluginFailureError(
        'policy',
        `插件 ${id} 的激活审批失败：${toMessage(error)}`,
      )
      this.recordFailure(entry, failure)
      return Promise.reject(failure)
    }
    if (verdict && typeof (verdict as { then?: unknown }).then === 'function') {
      const failure = new PluginFailureError(
        'policy',
        `插件 ${id} 的激活审批返回了 Promise；plugin/beforeActivate 必须是同步投票`,
      )
      this.recordFailure(entry, failure)
      return Promise.reject(failure)
    }
    if (verdict && verdict.allow === false) {
      const failure = new PluginFailureError(
        'policy',
        verdict.reason ? `插件 ${id} 被策略拒绝激活：${verdict.reason}` : `插件 ${id} 被策略拒绝激活`,
      )
      this.recordFailure(entry, failure)
      return Promise.reject(failure)
    }

    const task = this.startNow(entry, visiting)
    this.starting.set(id, task)
    void task
      .finally(() => {
        if (this.starting.get(id) === task) this.starting.delete(id)
      })
      .catch(() => {
        // 失败已经由 startNow 记录并抛给调用方，这里只负责清理登记
      })
    return task
  }

  private async startNow(entry: Entry, visiting: Set<PluginId>): Promise<void> {
    const { manifest } = entry.record
    const id = manifest.id
    const nextVisiting = new Set(visiting).add(id)
    entry.failure = undefined
    entry.startedAt = Date.now()
    this.setState(entry, 'activating')
    this.baseCtx.logger('plugins').info('正在加载插件 %s（v%s）', id, manifest.version)
    try {
      for (const dependency of manifest.dependencies ?? []) {
        const target = this.entries.get(dependency)
        if (!target) {
          throw new PluginFailureError('dependency', `插件 ${id} 依赖的 ${dependency} 未安装`)
        }
        // 依赖走同一条启动路径，但不重复加锁：外层已经持有当前插件的锁，
        // 依赖之间出现环时由 visiting 直接报错，而不是互相等待。
        try {
          await this.doStart(target, nextVisiting)
        } catch (error) {
          throw new PluginFailureError(
            'dependency',
            `插件 ${id} 的依赖 ${dependency} 未就绪：${toMessage(error)}`,
          )
        }
      }

      if (entry.record.entryMain) {
        let module: Record<string, unknown>
        try {
          module = await importPluginEntry(entry.record.entryMain)
        } catch (error) {
          throw new PluginFailureError('import', `导入 ${id} 的入口失败：${toMessage(error)}`)
        }
        let plugin: import('cordis').Plugin.Object<unknown>
        try {
          plugin = resolvePlugin(module, id)
        } catch (error) {
          throw new PluginFailureError('import', toMessage(error))
        }
        // 每个插件拿到独立的子上下文，带上 pluginId：
        // 服务通过 pluginIdOf(ctx) 就能实现「按插件隔离」的存储、命令归属等
        const scope = this.baseCtx.extend({ [PLUGIN_ID]: id }) as Context
        let fiber: Fiber
        try {
          fiber = await scope.plugin(plugin, { pluginId: id, manifest })
        } catch (error) {
          throw new PluginFailureError('apply', `插件 ${id} 启动失败：${toMessage(error)}`)
        }
        entry.fiber = fiber
        // cordis 允许插件在服务缺失时保持 pending：await 只等启动流程结束，
        // 不代表插件真的执行了。这里把 fiber 状态映射成插件状态并持续跟踪。
        this.watchFiber(entry, fiber)
        this.applyFiberState(entry)
        return
      }

      entry.failure = undefined
      this.setState(entry, 'active')
      this.announceActivated(entry)
      emitEvent(this.baseCtx, 'plugin/activated', id)
    } catch (error) {
      const failure =
        error instanceof PluginFailureError
          ? error
          : new PluginFailureError('apply', toMessage(error))
      this.recordFailure(entry, failure)
      throw failure
    }
  }

  /** 停掉 fiber；返回 true 表示超时（代码可能还在跑） */
  private async stop(entry: Entry): Promise<boolean> {
    const fiber = entry.fiber
    entry.fiber = undefined
    entry.waitingFor = undefined
    if (!fiber) return false
    const id = entry.record.manifest.id
    try {
      await withTimeout(
        Promise.resolve(fiber.dispose()),
        STOP_TIMEOUT_MS,
        `插件 ${id} 停止超时（${STOP_TIMEOUT_MS}ms）`,
      )
      this.baseCtx.logger('plugins').debug('插件 %s 已停止', id)
      return false
    } catch (error) {
      const message = toMessage(error)
      entry.failure = { stage: 'timeout', message, at: Date.now() }
      entry.restartRequired = true
      this.baseCtx.logger('plugins').warn(`插件 ${id} 停止异常：${message}`)
      return true
    } finally {
      // 使用记录属于运行时状态：重新激活时 require() 会重新登记
      const capabilities = this.baseCtx.get('capabilities') as
        | CapabilitiesDiagnostics
        | undefined
      capabilities?.forget?.(id)
    }
  }

  /** 记录失败并切到 failed；只在这里写 failure，避免 stage 与消息不同步 */
  private recordFailure(entry: Entry, failure: PluginFailureError): void {
    entry.failure = { stage: failure.stage, message: failure.message, at: Date.now() }
    this.setState(entry, 'failed')
    this.baseCtx
      .logger('plugins')
      .warn(`插件 ${entry.record.manifest.id} 激活失败（${failure.stage}）：${failure.message}`)
  }

  /**
   * 跟踪 fiber 状态：服务出现 / 消失时 cordis 会重新计算插件是否可运行，
   * 这里把那个结果同步成插件状态，界面与 RPC 路由才能看到真相。
   */
  private watchFiber(entry: Entry, fiber: Fiber): void {
    // 监听挂在 fiber 自己的上下文上：fiber 销毁时监听一起撤销，重载不会累积
    fiber.ctx.on('internal/status', (target: Fiber) => {
      if (target === fiber) this.applyFiberState(entry)
    })
  }

  private applyFiberState(entry: Entry): void {
    const fiber = entry.fiber
    if (!fiber) return

    const previous = entry.state
    const next: PluginState =
      fiber.state === FIBER_ACTIVE
        ? 'active'
        : fiber.state === FIBER_FAILED
          ? 'failed'
          : fiber.state === FIBER_PENDING
            ? 'waiting'
            : 'activating'

    if (next === 'waiting') {
      entry.waitingFor = this.unmetOf(fiber)
      entry.failure = undefined
    } else if (next === 'active') {
      entry.waitingFor = undefined
      entry.failure = undefined
    } else if (next === 'failed') {
      entry.failure ??= {
        stage: 'apply',
        message: '插件在运行中失效，详见日志',
        at: Date.now(),
      }
    }

    if (next === previous) return
    entry.state = next
    this.notify()
    if (next === 'active') {
      this.announceActivated(entry)
      emitEvent(this.baseCtx, 'plugin/activated', entry.record.manifest.id)
    } else if (next === 'waiting') {
      const unmet = entry.waitingFor ?? []
      this.baseCtx
        .logger('plugins')
        .info(
          '插件 %s 等待依赖服务：%s',
          entry.record.manifest.id,
          unmet.join('、') || '未知',
        )
    } else if (next === 'failed') {
      this.baseCtx.logger('plugins').warn('插件 %s 运行中失效', entry.record.manifest.id)
    }
  }

  /** 插件真正可运行后记一条带耗时的 info；耗时从 `正在加载` 开始算 */
  private announceActivated(entry: Entry): void {
    const id = entry.record.manifest.id
    const startedAt = entry.startedAt
    entry.startedAt = undefined
    if (startedAt === undefined) {
      this.baseCtx.logger('plugins').info('插件 %s 已激活', id)
      return
    }
    this.baseCtx.logger('plugins').info('插件 %s 已激活（%dms）', id, Date.now() - startedAt)
  }

  /** `inject` 里还没有提供方的服务名 */
  private unmetOf(fiber: Fiber): string[] {
    return Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined)
  }

  /**
   * 清单依赖的静态校验：缺失、自依赖、循环依赖。
   *
   * 这些问题在激活前就能确定，属于「装错了」；与运行期「服务没出现」的 waiting
   * 分开表达，用户才知道该改清单还是该启用别的插件。
   */
  private validateGraph(): void {
    for (const entry of this.entries.values()) entry.issues = undefined

    for (const [id, entry] of this.entries) {
      for (const dependency of entry.record.manifest.dependencies ?? []) {
        if (dependency === id) this.addIssue(id, '依赖自己')
        else if (!this.entries.has(dependency)) this.addIssue(id, `依赖的插件 ${dependency} 未安装`)
      }
    }

    const visited = new Map<PluginId, 'visiting' | 'done'>()
    const stack: PluginId[] = []
    const walk = (id: PluginId): void => {
      const status = visited.get(id)
      if (status === 'done') return
      if (status === 'visiting') {
        const start = stack.indexOf(id)
        const cycle = [...stack.slice(start), id]
        const label = `存在循环依赖：${cycle.join(' → ')}`
        for (const member of new Set(cycle)) this.addIssue(member, label)
        return
      }
      visited.set(id, 'visiting')
      stack.push(id)
      for (const dependency of this.entries.get(id)?.record.manifest.dependencies ?? []) {
        if (this.entries.has(dependency)) walk(dependency)
      }
      stack.pop()
      visited.set(id, 'done')
    }
    for (const id of this.entries.keys()) walk(id)

    // 依赖问题修好后要能从失败态里出来：否则用户装好依赖还得重启。
    // 只清 dependency 阶段的失败，import/apply 失败仍然需要重新加载。
    for (const entry of this.entries.values()) {
      if (entry.issues?.length) continue
      if (entry.state !== 'failed' || entry.failure?.stage !== 'dependency') continue
      entry.failure = undefined
      entry.state = 'discovered'
    }
  }

  private addIssue(id: PluginId, message: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const issues = (entry.issues ??= [])
    if (!issues.includes(message)) issues.push(message)
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
    this.scanIssues = scan.errors

    const next = new Map(scan.plugins.map((record) => [record.manifest.id, record]))

    // 目录消失：停掉并从列表里移除（重启后也不会再出现）
    for (const [id, entry] of [...this.entries]) {
      if (id === this.config.kernel || next.has(id)) continue
      const timedOut = await this.stop(entry)
      if (timedOut || entry.restartRequired) {
        // 旧代码没停下来：保留失败行，别把正在跑的东西从列表里抹掉
        this.setState(entry, 'failed')
        continue
      }
      this.entries.delete(id)
      this.userDisabled.delete(id)
      this.disabled.delete(id)
      this.forgetStorage(id)
    }

    // 目录集合变化后重新合并禁用来源；新出现的插件才能拿到正确初始状态
    this.rebuildEffectiveDisabled()

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
        const timedOut = await this.stop(entry)
        entry.state = timedOut ? 'failed' : 'disabled'
        if (!timedOut) entry.failure = undefined
      } else if (!this.disabled.has(id) && entry.state === 'disabled') {
        entry.state = 'discovered'
      }
    }

    this.validateGraph()
    this.persistDisabled()
    this.syncHost()
    this.notify()
    this.baseCtx
      .logger('plugins')
      .debug('插件目录已同步：%d 个插件，%d 个问题目录', this.entries.size, this.scanIssues.length)
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
    this.ipcAuditBaselines.delete(id)
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

  /** profile 是否把某个插件的开关锁在某个方向 */
  private profileLocked(id: PluginId): ProfileLock | undefined {
    const profile = this.config.profile
    if (!profile) return undefined
    if (profile.disable.includes(id)) return 'disabled'
    if (profile.enable.includes(id)) return 'enabled'
    return undefined
  }

  /**
   * 合并三处禁用来源：
   *   1. boot.config.disabled（部署静态）
   *   2. disabled-plugins.json（用户开关）
   *   3. profile.disable / profile.enable（部署 profile）
   *
   * 优先级：profile.disable > profile.enable > boot/user。core / essential
   * 永远不可禁用，因此会从结果里剔除并清掉对应用户记录。
   */
  private rebuildEffectiveDisabled(): void {
    const profile = this.config.profile
    const enable = new Set(profile?.enable ?? [])
    const disable = new Set(profile?.disable ?? [])

    const effective = new Set<PluginId>()
    for (const id of this.config.disabled) effective.add(id)
    for (const id of this.userDisabled) effective.add(id)
    for (const id of disable) effective.add(id)
    for (const id of enable) effective.delete(id)
    // disable 与 enable 同时出现时 disable 优先
    for (const id of disable) effective.add(id)

    for (const [id, entry] of this.entries) {
      if (!effective.has(id)) continue
      if (!this.isLocked(entry)) continue
      effective.delete(id)
      this.userDisabled.delete(id)
    }

    this.disabled.clear()
    for (const id of effective) this.disabled.add(id)
  }

  private setState(entry: Entry, state: PluginState): void {
    entry.state = state
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
    emitEvent(this.baseCtx, 'plugins/changed')
  }

  private statusOf(entry: Entry): PluginStatus {
    if (entry.state === 'disabled') return 'disabled'
    if (entry.state === 'failed') return 'failed'
    if (entry.state === 'waiting') return 'waiting'
    return 'enabled'
  }

  /**
   * 解析插件渲染端入口 URL。
   * 开发环境下改道 dev server（ELECTRON_RENDERER_URL），让插件视图源码经过
   * electron-vite dev server 转换并注入 inspector 定位元数据，从而支持点击跳转源码；
   * 生产 / 无源码入口时回退到预构建 bundle（mics-plugin://）。
   */
  private resolveRenderUrl(record: PluginRecord, renderer?: string): string | undefined {
    if (!renderer) return undefined
    const devOrigin = process.env.ELECTRON_RENDERER_URL
    if (devOrigin) {
      const sourceEntry = path.join(record.dir, 'src', 'renderer', 'index.ts')
      if (existsSync(sourceEntry)) {
        // /@fs/ 期望未编码的绝对路径（盘符冒号不编码），仅统一为 '/' 并处理非法字符
        const encoded = encodeURI(sourceEntry.split(path.sep).join('/'))
        return `${devOrigin}/@fs/${encoded}`
      }
    }
    return `${PLUGIN_SCHEME}://${record.manifest.id}/${encodePath(renderer)}`
  }

  private describe(entry: Entry): PluginInfo {
    const { manifest, source } = entry.record
    const builtin = source === 'builtin'
    const renderer = manifest.renderer
    const profileLock = this.isLocked(entry) ? undefined : this.profileLocked(manifest.id)
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
      canDisable: !this.isLocked(entry) && !profileLock,
      profileLocked: profileLock,
      uninstallable: !builtin,
      hasUninstall: Boolean(entry.record.entryUninstall),
      manifest,
      hasMain: Boolean(entry.record.entryMain),
      hasRenderer: Boolean(entry.record.entryRenderer),
      rendererUrl: this.resolveRenderUrl(entry.record, renderer),
      styles: (manifest.styles ?? []).map(
        (style) => `${PLUGIN_SCHEME}://${manifest.id}/${encodePath(style)}`,
      ),
      waitingFor: entry.state === 'waiting' ? entry.waitingFor : undefined,
      dependencyIssues: entry.issues?.length ? [...entry.issues] : undefined,
      failure: entry.failure,
      restartRequired: entry.restartRequired,
      error: entry.failure?.message,
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
      // 只持久化用户开关：boot.config / profile 是部署侧输入，不写回用户文件
      writeFileSync(this.disabledFile(), JSON.stringify([...this.userDisabled], null, 2), 'utf8')
    } catch (error) {
      this.baseCtx.logger('plugins').warn(`保存禁用列表失败：${toMessage(error)}`)
    }
  }
}