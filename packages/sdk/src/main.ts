import type { Plugin } from 'cordis'
import './contract/services'

/**
 * 主进程插件的类型标注辅助函数。
 *
 * 插件本身就是一个普通的 cordis 插件对象：`{ name, inject, apply }`。
 * cordis 会负责依赖注入、生命周期与 effect 回收。
 */
export function defineMainPlugin<T = unknown>(plugin: Plugin.Object<T>): Plugin.Object<T> {
  return plugin
}

export type { Plugin }
