import type { Context, Fiber, Plugin } from 'cordis'
import { Service } from 'cordis'
import type {
  Disposable,
  PluginGraphReport,
  PluginId,
  PluginInfo,
  RuntimeSnapshot,
} from '@mics/sdk'
import { FIBER_ACTIVE, PLUGIN_ID, PluginFailureError } from '@mics/sdk'
import { reportCleanup, snapshotCleanup, type CleanupSnapshot } from '../cleanupAudit'
import { applySnapshot, ensureStyle, removeStyle, store } from '../store'

/**
 * 渲染进程的插件宿主。
 *
 * 启动时拉取内核快照（清单层面的贡献点立刻可用），
 * 某个页面第一次被打开时才真正 import 插件产物、创建 cordis fiber。
 *
 * 禁用状态以内核为准（持久化），渲染端只负责同步与卸载。
 * 启用 / 重载 / 卸载都是「双进程事务」：内核那一半和页面这一半必须一起成功或
 * 一起失败，因此这里在每个动作之后都会重新拉快照，并把失败回报给内核。
 *
 * 兄弟服务统一走自身上下文（owner）：cordis 的追踪上下文属于调用方，
 * 调用方（插件）未必声明了对应 inject。
 */
export class PluginsService extends Service {
  static inject = ['ipc', 'ui', 'commands', 'theme']

  private readonly owner: Context
  private readonly baseCtx: Context
  private readonly fibers = new Map<PluginId, Fiber>()
  private readonly scopes = new Map<PluginId, Context>()
  private readonly loading = new Map<PluginId, Promise<void>>()
  private readonly loaded = new Set<PluginId>()
  /** 插件注册过的样式链接（带版本号），卸载时按这份记录移除 */
  private readonly styles = new Map<PluginId, string[]>()
  /** 单调递增：每次加载插件都用新的 ?v= 绕过 ESM 模块缓存 */
  private stamp = 0
  /** dev 清理审计：每个插件上一次重载后的渲染端注册快照 */
  private readonly auditBaselines = new Map<PluginId, CleanupSnapshot>()

  constructor(ctx: Context) {
    super(ctx, 'plugins')
    this.owner = ctx
    this.baseCtx = ctx
  }

  async [Service.init](): Promise<void> {
    try {
      // 主进程的内核服务可能还在注册系统 RPC，这里做有限重试
      await this.waitForKernel()
      this.owner.theme.restore()
    } catch (error) {
      store.bootError = error instanceof Error ? error.message : String(error)
    }
  }

  private async waitForKernel(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const snapshot = await this.owner.ipc.invoke<RuntimeSnapshot>('mics.kernel', 'runtime/snapshot')
        applySnapshot(snapshot)
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  list(): PluginInfo[] {
    return store.plugins
  }

  get(id: PluginId): PluginInfo | undefined {
    return store.plugins.find((plugin) => plugin.id === id)
  }

  snapshot(): RuntimeSnapshot {
    if (!store.app) throw new Error('[mics] 运行时尚未就绪')
    return { app: store.app, plugins: store.plugins, commands: store.commands }
  }

  contextOf(id: PluginId): Context | undefined {
    return this.scopes.get(id)
  }

  async refresh(): Promise<void> {
    const snapshot = await this.owner.ipc.invoke<RuntimeSnapshot>('mics.kernel', 'runtime/snapshot')
    applySnapshot(snapshot)
    // 当前主题可能随插件禁用而消失，需要回退到仍可用的主题
    this.owner.theme.reconcile()
    await this.reconcile()
  }

  /**
   * 依赖图与贡献点诊断。
   *
   * 渲染端只负责转发：数据由内核收集，页面与 agent 读同一份。
   */
  async diagnostics(): Promise<PluginGraphReport> {
    return this.owner.ipc.invoke<PluginGraphReport>('mics.kernel', 'plugins/diagnostics')
  }

  onDidChange(listener: () => void): Disposable {
    return this.owner.ipc.on('plugins/changed', () => listener())
  }

  async activate(id: PluginId): Promise<void> {
    const info = this.get(id)
    if (!info) throw new Error(`未知插件 ${id}`)
    if (info.state === 'disabled') {
      throw new Error(`插件 ${id} 已被禁用，请先在插件面板中启用`)
    }
    if (this.loaded.has(id)) return
    const running = this.loading.get(id)
    if (running) return running
    const task = this.doActivate(info)
      .catch(async (error) => {
        // 页面这一半的失败也要回报内核，列表与诊断才会显示真实阶段
        await this.reportFailure(id, error)
        throw error
      })
      .finally(() => this.loading.delete(id))
    this.loading.set(id, task)
    return task
  }

  /** 只卸掉页面、样式与作用域，不改插件状态（重载 / 卸载的第一步） */
  async unload(id: PluginId): Promise<void> {
    const fiber = this.fibers.get(id)
    this.fibers.delete(id)
    this.scopes.delete(id)
    this.loaded.delete(id)
    for (const href of this.styles.get(id) ?? []) removeStyle(href)
    this.styles.delete(id)
    if (fiber) await fiber.dispose()
  }

  /** 禁用：由内核持久化禁用状态，再卸载渲染端 fiber 与样式 */
  async disable(id: PluginId): Promise<void> {
    const info = this.get(id)
    if (!info) throw new Error(`未知插件 ${id}`)
    if (!info.canDisable) {
      throw new Error(
        info.core ? `内核插件 ${id} 不可禁用` : `插件 ${id} 是必需插件，不可禁用`,
      )
    }

    // 先让内核落地状态；失败时渲染端仍保持原样
    await this.owner.ipc.invoke('mics.kernel', 'plugins/disable', { id })
    await this.unload(id)
    delete store.errors[id]
    await this.refresh()
  }

  /** 启用：解除内核侧的禁用并重新加载渲染端；失败由 activate() 回报内核 */
  async enable(id: PluginId): Promise<void> {
    await this.owner.ipc.invoke('mics.kernel', 'plugins/enable', { id })
    // 先刷新快照，激活逻辑才能看到 state 已不再是 disabled
    await this.refresh()
    await this.activate(id)
    await this.refresh()
  }

  /**
   * 重载：先卸页面，再让内核重建主进程 fiber，最后重新 import 页面产物。
   *
   * 顺序不能反：如果先重建主进程而页面还是旧代码，两边会短暂地一半新一半旧。
   */
  async reload(id: PluginId): Promise<void> {
    const info = this.get(id)
    if (!info) throw new Error(`未知插件 ${id}`)
    if (info.state === 'disabled') throw new Error(`插件 ${id} 已禁用，请先启用再重载`)

    // 第一次重载只建立基线；之后比较同一个插件的注册数量是否增长
    const audit = import.meta.env.DEV ? snapshotCleanup() : undefined
    try {
      await this.unload(id)
      try {
        await this.owner.ipc.invoke('mics.kernel', 'plugins/reload', { id })
      } catch (error) {
        // 内核已经带着准确阶段写进失败态；拉一次快照即可，不要覆盖它
        await this.refresh().catch(() => {})
        throw error
      }
      await this.refresh()
      await this.activate(id)
      await this.refresh()
    } finally {
      if (audit) {
        const current = snapshotCleanup()
        reportCleanup(id, this.auditBaselines.get(id), current, (message) =>
          console.warn(`[mics.cleanup] ${message}`),
        )
        this.auditBaselines.set(id, current)
      }
    }
  }

  private async doActivate(info: PluginInfo): Promise<void> {
    store.activating[info.id] = true
    delete store.errors[info.id]
    try {
      // 渲染端插件也在内核侧标记为已激活，保持主进程与渲染进程的生命周期一致。
      await this.owner.ipc.invoke('mics.kernel', 'plugins/activate', { id: info.id })

      if (info.hasRenderer && info.rendererUrl) {
        const version = ++this.stamp
        const hrefs = info.styles.map((href) => `${href}?v=${version}`)
        for (const href of hrefs) ensureStyle(href)
        this.styles.set(info.id, hrefs)

        // 渲染端最小隔离：
        //   - bridge 是壳专用服务，插件只能通过 ctx.ipc 访问主进程；隔离后
        //     插件上下文里拿不到 ctx.bridge，避免伪造 callerId / 绕过 IPC 服务；
        //   - 真正能访问 window/document 的完整沙箱（iframe / utility process）在 M3。
        const scope = (this.baseCtx.extend({ [PLUGIN_ID]: info.id }) as Context).isolate('bridge')
        this.scopes.set(info.id, scope)
        let module: Record<string, unknown>
        try {
          module = (await import(
            /* @vite-ignore */ `${info.rendererUrl}?v=${version}`
          )) as Record<string, unknown>
        } catch (error) {
          throw new PluginFailureError(
            'import',
            `导入插件 ${info.id} 的页面产物失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const candidate = (module.default ?? module) as unknown as Plugin | undefined
        if (
          candidate &&
          (typeof candidate === 'function' ||
            typeof (candidate as { apply?: unknown }).apply === 'function')
        ) {
          let fiber: Fiber
          try {
            fiber = await scope.plugin(candidate as unknown as Plugin.Object<unknown>, {
              pluginId: info.id,
              manifest: info.manifest,
            })
          } catch (error) {
            throw new PluginFailureError(
              'apply',
              `插件 ${info.id} 的页面启动失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
          // 服务缺失时 cordis 只会让插件停在 pending：页面什么都不注册，
          // 用户看到的是「已启用但空白」。这里显式失败，错误信息能指到具体服务。
          const unmet = Object.keys(fiber.inject).filter(
            (name) => fiber.ctx.get(name) === undefined,
          )
          if (fiber.state !== FIBER_ACTIVE || unmet.length > 0) {
            await fiber.dispose()
            throw new PluginFailureError(
              unmet.length > 0 ? 'dependency' : 'apply',
              `插件 ${info.id} 声明的服务尚未提供：${unmet.join('、') || '未知'}`,
            )
          }
          this.fibers.set(info.id, fiber)
        }
      }

      this.loaded.add(info.id)
    } catch (error) {
      // 失败就把已经加上去的样式与 fiber 收回去，避免留下半个插件
      await this.unload(info.id).catch(() => {})
      store.errors[info.id] = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      store.activating[info.id] = false
    }
  }

  /** 渲染端失败 → 主进程也停下并标记失败，避免「后台还在跑、页面已经坏了」 */
  private async reportFailure(id: PluginId, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    store.errors[id] = message
    // 主进程激活/重载失败时已经带着准确阶段写进失败态；这里只刷新快照，
    // 不能用一个笼统的 renderer 阶段把它覆盖掉。
    if (!(error instanceof PluginFailureError)) {
      await this.refresh().catch(() => {})
      return
    }
    try {
      await this.owner.ipc.invoke('mics.kernel', 'plugins/fail', {
        id,
        message,
        stage: error.stage,
      })
      await this.refresh()
    } catch {
      // 主进程可能已经不可用（例如内核自身出错），保留本地错误即可
    }
  }

  /**
   * 让渲染端跟上内核快照：插件消失（卸载）或被禁用时，页面和样式必须一起消失。
   * 否则「已卸载」的插件会留下一个再也打不开的导航页。
   */
  private async reconcile(): Promise<void> {
    const alive = new Set(store.plugins.map((plugin) => plugin.id))
    for (const id of [...this.auditBaselines.keys()]) {
      if (!alive.has(id)) this.auditBaselines.delete(id)
    }
    for (const id of [...this.loaded]) {
      if (!alive.has(id)) await this.unload(id)
    }
    for (const id of [...this.fibers.keys()]) {
      if (!alive.has(id)) await this.unload(id)
    }
    for (const plugin of store.plugins) {
      if (plugin.state !== 'disabled') continue
      if (this.loaded.has(plugin.id) || this.fibers.has(plugin.id)) await this.unload(plugin.id)
    }
  }
}
