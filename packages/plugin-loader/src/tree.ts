import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginRecord } from '@mics/sdk'

/**
 * Cordis Include 的一个 entry。
 *
 * 形状对齐 `@cordisjs/plugin-loader` 的 `EntryOptions`：只保留 mics 需要生成的部分，
 * 这样本包不必依赖框架，插件目录也能被独立分发。
 */
export interface PluginTreeEntry {
  id: string
  name: string
  disabled?: boolean
  config: {
    pluginId: string
  }
}

export interface BuildPluginTreeOptions {
  /** 生效的禁用集合（boot / profile / 用户开关已经合并） */
  disabled?: Iterable<string>
}

/** 插件主进程入口的 `file://` URL；没有主进程入口时返回 undefined */
export function mainEntryUrl(record: PluginRecord): string | undefined {
  if (!record.entryMain) return undefined
  return pathToFileURL(path.resolve(record.entryMain)).href
}

/**
 * 由扫描结果生成 Include 的入口列表。
 *
 * 只有带主进程入口的插件能进树：Loader 的 entry 必须有可 import 的模块。
 * 纯渲染插件（例如设置页）没有主进程半边，它们的禁用状态仍由
 * `disabled-plugins.json` 管理——这是迁移期的已知分裂，等每个插件都有
 * 主进程入口后再合并成单一来源。
 *
 * 顺序按 id 排序，保证重新生成时文件 diff 稳定。
 */
export function buildPluginTree(
  records: readonly PluginRecord[],
  options: BuildPluginTreeOptions = {}
): PluginTreeEntry[] {
  const disabled = new Set(options.disabled ?? [])
  const entries: PluginTreeEntry[] = []
  for (const record of records) {
    const id = record.manifest.id
    const name = mainEntryUrl(record)
    if (!name) continue
    entries.push({
      id,
      name,
      ...(disabled.has(id) ? { disabled: true } : {}),
      // 清单不进 entry：nav 等元数据仍由扫描提供，写进 yml 只会让文件变长且重复
      config: { pluginId: id }
    })
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return entries
}
