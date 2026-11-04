import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import type { PluginTreeEntry } from '@mics/plugin-loader'

/**
 * `cordis.yml` 的读写。
 *
 * 文件是**生成物**：条目来自目录扫描，这里只负责把「谁被禁用」这类部署状态
 * 持久化下来。启动代码自己创建 entry（dsh 的 `entries.start` 模型），
 * 因此不需要 Include 参与挂载，也就不存在「文件解析完成」的等待问题。
 */
export interface TreeFileState {
  /** 文件里声明过的 entry（可能已过时，由调用方与扫描结果对齐） */
  entries: PluginTreeEntry[]
  /** 文件里显式禁用（或不存在于文件、但历史记录禁用）的插件 id */
  disabled: Set<string>
}

const EMPTY: TreeFileState = { entries: [], disabled: new Set() }

/** 读文件；缺失或损坏都退化成空状态，让调用方按扫描结果继续 */
export function readTreeFile(file: string, onWarning?: (message: string) => void): TreeFileState {
  if (!existsSync(file)) return { entries: [], disabled: new Set() }
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (error) {
    onWarning?.(`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`)
    return { entries: [], disabled: new Set() }
  }
  if (!Array.isArray(raw)) {
    onWarning?.(`${file} 不是 entry 列表，已忽略`)
    return EMPTY
  }

  const entries: PluginTreeEntry[] = []
  const disabled = new Set<string>()
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : undefined
    const name = typeof item.name === 'string' ? item.name : undefined
    if (!id || !name) continue
    const isDisabled = item.disabled === true
    entries.push({
      id,
      name,
      ...(isDisabled ? { disabled: true } : {}),
      config: { pluginId: id }
    })
    if (isDisabled) disabled.add(id)
  }
  return { entries, disabled }
}

/** 覆盖写入；目录不存在时先建出来（首启 userData 可能还没有这个目录） */
export function writeTreeFile(file: string, entries: PluginTreeEntry[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const body = stringify(
    entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.disabled ? { disabled: true } : {}),
      config: { pluginId: entry.config.pluginId }
    }))
  )
  writeFileSync(file, body, 'utf8')
}
