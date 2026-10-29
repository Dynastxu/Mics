import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Component } from 'vue'
import type { Disposable, PluginId, RendererStatusBarItem } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'
import { navItemById, store, viewComponents } from '../store'

/**
 * 渲染进程 UI 服务：导航页面与状态栏的注册表。
 * 注册调用发生在插件 fiber 内，因此 dispose 插件即可把 UI 一并摘掉。
 *
 * 最小隔离：注册表按插件 id 记录归属，跨插件覆盖同一个 view / 状态栏 id
 * 会直接失败。完整 iframe / utility process 沙箱仍在 M3。
 */
export class UiService extends Service {
  private readonly viewOwners = new Map<string, PluginId>()
  private readonly statusOwners = new Map<string, PluginId>()

  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  registerView(viewId: string, component: Component): Disposable {
    const owner = pluginIdOf(this.ctx)
    const existing = this.viewOwners.get(viewId)
    if (existing && existing !== owner) {
      throw new Error(`页面 ${viewId} 已由插件 ${existing} 注册，${owner ?? '当前插件'} 不能覆盖`)
    }
    if (owner) this.viewOwners.set(viewId, owner)
    viewComponents[viewId] = component
    return this.ctx.effect(() => () => {
      if (viewComponents[viewId] === component) delete viewComponents[viewId]
      if (owner && this.viewOwners.get(viewId) === owner) this.viewOwners.delete(viewId)
    })
  }

  registerStatusBarItem(item: RendererStatusBarItem): Disposable {
    const owner = pluginIdOf(this.ctx)
    const existing = this.statusOwners.get(item.id)
    if (existing && existing !== owner) {
      throw new Error(`状态栏 ${item.id} 已由插件 ${existing} 注册，${owner ?? '当前插件'} 不能覆盖`)
    }
    if (owner) this.statusOwners.set(item.id, owner)
    const entry = { ...item, pluginId: owner, source: 'runtime' as const }
    store.runtimeStatus.push(entry)
    return this.ctx.effect(() => () => {
      const index = store.runtimeStatus.indexOf(entry)
      if (index >= 0) store.runtimeStatus.splice(index, 1)
      if (owner && this.statusOwners.get(item.id) === owner) this.statusOwners.delete(item.id)
    })
  }

  componentOf(viewId: string): Component | undefined {
    return viewComponents[viewId]
  }

  /** 诊断用：某个页面当前由哪个插件注册 */
  ownerOf(viewId: string): PluginId | undefined {
    return this.viewOwners.get(viewId)
  }

  /**
   * 切换到清单贡献的导航页面。
   * 只改 store，页面组件由 PageHost 负责按需激活；
   * 目标页面不存在（插件缺失或被禁用）时保持当前页面并返回 false。
   */
  navigate(viewId: string): boolean {
    if (!navItemById(viewId)) return false
    store.activeView = viewId
    return true
  }
}
