import { inject, type InjectionKey } from 'vue'
import type { Context, Plugin } from 'cordis'
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
 * 渲染进程插件的类型标注辅助函数。
 * 插件同样是 cordis 插件对象；UI 贡献通过 ctx.ui 注册，
 * 并随插件 fiber 的销毁而自动回收。
 */
export function defineRendererPlugin(plugin: Plugin.Object): Plugin.Object {
  return plugin
}

export type { Context, Plugin }
