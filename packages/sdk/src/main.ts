import type { Plugin } from 'cordis'
import './contract/events'
import './contract/services'

// 磁盘布局解析是主进程插件的共享实现（启动与下载必须用同一份规则），
// 因此挂在 `/main` 入口；`node/` 下只放依赖 Node 的模块，渲染进程不引入。
export * from './node/layout'
export * from './node/zip'

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
