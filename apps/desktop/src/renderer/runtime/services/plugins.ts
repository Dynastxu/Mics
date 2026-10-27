import type { Context, Fiber, Plugin } from 'cordis'
import { Service } from 'cordis'
import type { Disposable, PluginId, PluginInfo, RuntimeSnapshot } from '@mics/sdk'
import { PLUGIN_ID } from '@mics/sdk'
import { applySnapshot, ensureStyle, store } from '../store'

/**
 * 渲染进程的插件宿主。
 *
 * 启动时拉取内核快照（清单层面的贡献点立刻可用），
 * 某个页面第一次被打开时才真正 import 插件产物、创建 cordis fiber。
 *
 * 禁用状态以内核为准（持久化），渲染端只负责同步与卸载。
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
    const task = this.doActivate(info).finally(() => this.loading.delete(id))
    this.loading.set(id, task)
    return task
  }

  /** 禁用：卸载渲染端 fiber，并由内核持久化禁用状态 */
  async disable(id: PluginId): Promise<void> {
    const fiber = this.fibers.get(id)
    if (fiber) {
      await fiber.dispose()
      this.fibers.delete(id)
    }
    this.loaded.delete(id)
    this.scopes.delete(id)
    await this.owner.ipc.invoke('mics.kernel', 'plugins/disable', { id })
    await this.refresh()
  }

  /** 启用：解除内核侧的禁用并重新加载渲染端 */
  async enable(id: PluginId): Promise<void> {
    await this.owner.ipc.invoke('mics.kernel', 'plugins/enable', { id })
    // 先刷新快照，激活逻辑才能看到 state 已不再是 disabled
    await this.refresh()
    await this.activate(id)
    await this.refresh()
  }

  private async doActivate(info: PluginInfo): Promise<void> {
    store.activating[info.id] = true
    delete store.errors[info.id]
    try {
      // 渲染端插件也在内核侧标记为已激活：插件管理页显示的是内核快照，
      // 不这样做，纯渲染插件会一直显示「未激活」。
      await this.owner.ipc.invoke('mics.kernel', 'plugins/activate', { id: info.id })

      if (info.hasRenderer && info.rendererUrl) {
        for (const href of info.styles) ensureStyle(href)
        const scope = this.baseCtx.extend({ [PLUGIN_ID]: info.id }) as Context
        this.scopes.set(info.id, scope)
        const module = (await import(/* @vite-ignore */ info.rendererUrl)) as Record<string, unknown>
        const candidate = (module.default ?? module) as unknown as Plugin | undefined
        if (
          candidate &&
          (typeof candidate === 'function' ||
            typeof (candidate as { apply?: unknown }).apply === 'function')
        ) {
          const fiber = await scope.plugin(candidate as unknown as Plugin.Object<unknown>, {
            pluginId: info.id,
            manifest: info.manifest,
          })
          this.fibers.set(info.id, fiber)
        }
      }

      this.loaded.add(info.id)
    } catch (error) {
      store.errors[info.id] = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      store.activating[info.id] = false
    }
  }
}
