import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Component } from 'vue'
import type { Disposable, RendererStatusBarItem } from '@mics/sdk'
import { pluginIdOf } from '@mics/sdk'
import { store, viewComponents } from '../store'

/**
 * 渲染进程 UI 服务：导航页面与状态栏的注册表。
 * 注册调用发生在插件 fiber 内，因此 dispose 插件即可把 UI 一并摘掉。
 */
export class UiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  registerView(viewId: string, component: Component): Disposable {
    viewComponents[viewId] = component
    return this.ctx.effect(() => () => {
      if (viewComponents[viewId] === component) delete viewComponents[viewId]
    })
  }

  registerStatusBarItem(item: RendererStatusBarItem): Disposable {
    const entry = { ...item, pluginId: pluginIdOf(this.ctx), source: 'runtime' as const }
    store.runtimeStatus.push(entry)
    return this.ctx.effect(() => () => {
      const index = store.runtimeStatus.indexOf(entry)
      if (index >= 0) store.runtimeStatus.splice(index, 1)
    })
  }

  componentOf(viewId: string): Component | undefined {
    return viewComponents[viewId]
  }
}
