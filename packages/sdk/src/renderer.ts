import {
  computed,
  defineComponent,
  h,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey
} from 'vue'
import type { Context, Plugin } from 'cordis'
import type { SettingsGroupContribution } from './contract/services'
import './contract/events'
import './contract/services'

/**
 * 渲染进程插件的页面组件里，通过 usePluginContext() 拿到所属插件的作用域。
 * ctx 由 shell 在挂载页面时通过 provide 注入（见 PluginScope.vue）。
 */
export const PLUGIN_CONTEXT_KEY = Symbol.for('mics.plugin-context') as InjectionKey<Context>

export function usePluginContext(): Context {
  const ctx = inject(PLUGIN_CONTEXT_KEY, null)
  if (!ctx) {
    throw new Error('[mics] usePluginContext() 只能在插件提供的页面组件内使用')
  }
  return ctx
}

/**
 * 读取其它插件追加到某个设置页的分组，按 `order` 排序后交给 `<SettingsPage>`。
 *
 * 每个分组都包了一层作用域：分组组件里 `usePluginContext()` 拿到的是注册方
 * 插件，而不是渲染这个页面的宿主插件。
 */
export function useSettingsExtensions(pageId: string): ComputedRef<SettingsGroupContribution[]> {
  const ctx = usePluginContext()
  return computed(() =>
    [...ctx.ui.settingsGroups(pageId)]
      .sort(
        (left, right) =>
          (left.order ?? 100) - (right.order ?? 100) || left.id.localeCompare(right.id)
      )
      .map(scopedSettingsGroup)
  )
}

/** 注册信息是 markRaw 的稳定对象：按对象身份缓存包装组件，避免无关注册导致分组重挂载 */
const scopedGroups = new WeakMap<SettingsGroupContribution, SettingsGroupContribution>()

function scopedSettingsGroup(group: SettingsGroupContribution): SettingsGroupContribution {
  const cached = scopedGroups.get(group)
  if (cached) return cached
  const context = group.context as Context | undefined
  if (!context) return group
  const component = defineComponent({
    name: `SettingsGroupScope(${group.id})`,
    setup() {
      provide(PLUGIN_CONTEXT_KEY, context)
      return () => h(group.component, group.props)
    }
  })
  const wrapped = { ...group, component }
  scopedGroups.set(group, wrapped)
  return wrapped
}

/**
 * 用系统浏览器打开 http(s) 链接。
 *
 * 走内核的 `host/openExternal`，因此调用方插件必须在 plugin.json 里声明
 * `"permissions": ["shell:openExternal"]`；渲染进程里直接 `window.open`
 * 虽然也能被外壳转交，但绕过了权限声明，插件应统一用这个入口。
 */
export function useOpenExternal(): (url: string) => Promise<void> {
  const ctx = usePluginContext()
  return (url: string) =>
    ctx.ipc.invoke('mics.kernel', 'host/openExternal', { url }).then(() => undefined)
}

/**
 * 渲染进程插件的类型标注辅助函数。
 * 插件同样是 cordis 插件对象；UI 贡献通过 ctx.ui 注册，
 * 并随插件 fiber 的销毁而自动回收。
 */
export function defineRendererPlugin(plugin: Plugin.Object): Plugin.Object {
  return plugin
}

export type { Context, Plugin }
