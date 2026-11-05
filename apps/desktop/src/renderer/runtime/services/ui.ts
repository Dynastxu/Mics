import type { Context } from 'cordis'
import { Service, symbols } from 'cordis'
import { markRaw, type Component } from 'vue'
import type {
  Disposable,
  PluginId,
  RendererStatusBarItem,
  SettingsGroupContribution,
  SettingsGroupRegistration,
  SettingsSection
} from '@mics/sdk'
import { GENERAL_SETTINGS_PAGE, pluginIdOf } from '@mics/sdk'
import { navItemById, store, viewComponents } from '../store'

/**
 * 取服务调用方自己的 Context。
 *
 * 服务方法里的 `this.ctx` 是 cordis 的 shadow Context：符号属性（pluginId）能沿
 * 原型找到调用方，但服务解析用的是 shadow 的注入表，直接拿它访问 `ctx.ipc`
 * 会报 `cannot get property "ipc" without inject`。注册出去、渲染期还要继续用的
 * Context 必须是真正的调用方作用域。
 */
function callerContext(ctx: Context): Context {
  const shadowed = Boolean((ctx as unknown as Record<symbol, unknown>)[symbols.shadow])
  return shadowed ? (Object.getPrototypeOf(ctx) as Context) : ctx
}

/**
 * 渲染进程 UI 服务：导航页面、状态栏与设置分组的注册表。
 * 注册调用发生在插件 fiber 内，因此 dispose 插件即可把 UI 一并摘掉。
 *
 * 最小隔离：注册表按插件 id 记录归属，跨插件覆盖同一个 view / 状态栏 / 分组
 * 会直接失败。完整 iframe / utility process 沙箱仍在 M3。
 */
export class UiService extends Service {
  private readonly viewOwners = new Map<string, PluginId>()
  private readonly statusOwners = new Map<string, PluginId>()
  private readonly settingsOwners = new Map<string, PluginId>()

  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  registerView(viewId: string, component: Component): Disposable {
    const caller = callerContext(this.ctx)
    const owner = pluginIdOf(caller)
    const existing = this.viewOwners.get(viewId)
    if (existing && existing !== owner) {
      throw new Error(`页面 ${viewId} 已由插件 ${existing} 注册，${owner ?? '当前插件'} 不能覆盖`)
    }
    if (owner) this.viewOwners.set(viewId, owner)
    viewComponents[viewId] = component
    return caller.effect(() => () => {
      if (viewComponents[viewId] === component) delete viewComponents[viewId]
      if (owner && this.viewOwners.get(viewId) === owner) this.viewOwners.delete(viewId)
    })
  }

  registerSettingsGroup(group: SettingsGroupRegistration): Disposable {
    return this.addSettingsGroup(group, callerContext(this.ctx))
  }

  settingsGroups(pageId: string): SettingsGroupContribution[] {
    return store.settingsGroups.filter((group) => group.pageId === pageId)
  }

  /** @deprecated 用 registerSettingsGroup({ pageId: GENERAL_SETTINGS_PAGE, ... }) */
  registerSettingsSection(section: SettingsSection): Disposable {
    return this.addSettingsGroup(
      { ...section, pageId: GENERAL_SETTINGS_PAGE },
      callerContext(this.ctx)
    )
  }

  /** @deprecated 用 settingsGroups(GENERAL_SETTINGS_PAGE) */
  settingsSections(): SettingsSection[] {
    return this.settingsGroups(GENERAL_SETTINGS_PAGE)
  }

  /**
   * 注册入口都先解析出调用方 Context；旧接口在内部转调时不能再用
   * `this.ctx`（那已经是服务自己的作用域），所以把 caller 显式传进来。
   */
  private addSettingsGroup(group: SettingsGroupRegistration, caller: Context): Disposable {
    const owner = pluginIdOf(caller)
    if (!group.pageId || !group.id) {
      throw new Error('设置分组必须声明 pageId 与 id')
    }
    const key = `${group.pageId}\u0000${group.id}`
    const existing = this.settingsOwners.get(key)
    if (existing) {
      throw new Error(
        `设置页 ${group.pageId} 的分组 ${group.id} 已由插件 ${existing} 注册，` +
          `${owner ?? '当前插件'} 不能覆盖`
      )
    }
    if (owner) this.settingsOwners.set(key, owner)
    // 分组里有 Vue 组件与插件 Context：markRaw 避免被 reactive 深度代理
    const entry = markRaw({
      ...group,
      pluginId: owner,
      context: caller
    }) satisfies SettingsGroupContribution
    store.settingsGroups.push(entry)
    return caller.effect(() => () => {
      const index = store.settingsGroups.indexOf(entry)
      if (index >= 0) store.settingsGroups.splice(index, 1)
      if (owner && this.settingsOwners.get(key) === owner) {
        this.settingsOwners.delete(key)
      }
    })
  }

  registerStatusBarItem(item: RendererStatusBarItem): Disposable {
    const caller = callerContext(this.ctx)
    const owner = pluginIdOf(caller)
    const existing = this.statusOwners.get(item.id)
    if (existing && existing !== owner) {
      throw new Error(
        `状态栏 ${item.id} 已由插件 ${existing} 注册，${owner ?? '当前插件'} 不能覆盖`
      )
    }
    if (owner) this.statusOwners.set(item.id, owner)
    const entry = { ...item, pluginId: owner, source: 'runtime' as const }
    store.runtimeStatus.push(entry)
    return caller.effect(() => () => {
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
