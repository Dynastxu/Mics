import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginRecord, PluginSource, ScanError, ScanResult } from '@mics/sdk'
import { isSafeRelativePath, validateManifest } from './manifest'

/** 一个扫描根：内置目录只读，用户目录可写 */
export interface PluginRoot {
  dir: string
  source: PluginSource
}

export interface PluginDirectoryResult {
  record?: PluginRecord
  errors: string[]
}

/** 安装暂存目录；以 `.` 开头，扫描时会被跳过 */
export const STAGING_DIR = '.staging'

/** 把清单里的相对入口解析为插件目录内的绝对路径；越界或不存在返回 undefined */
export function resolveEntry(dir: string, relative: string): string | undefined {
  if (!isSafeRelativePath(relative)) return undefined
  const absolute = path.resolve(dir, relative)
  const normalizedDir = dir.toLowerCase()
  const normalizedFile = absolute.toLowerCase()
  if (normalizedFile !== normalizedDir && !normalizedFile.startsWith(`${normalizedDir}${path.sep}`)) {
    return undefined
  }
  return existsSync(absolute) ? absolute : undefined
}

/**
 * 读取单个插件目录。
 *
 * `strict` 用于安装校验：清单声明的入口不存在时直接报错，而不是像启动扫描那样
 * 只给一条警告放行——装进去一个跑不起来的插件，比装之前就失败更糟。
 */
export async function readPluginDirectory(
  dir: string,
  source: PluginSource,
  strict = false,
): Promise<PluginDirectoryResult> {
  const manifestFile = path.join(dir, 'plugin.json')
  if (!existsSync(manifestFile)) return { errors: ['缺少 plugin.json'] }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    return { errors: [`plugin.json 解析失败: ${(error as Error).message}`] }
  }

  const result = validateManifest(raw)
  if (!result.manifest || result.errors.length > 0) {
    return { errors: result.errors.length ? result.errors : ['清单无效'] }
  }

  const manifest = result.manifest
  const record: PluginRecord = {
    dir,
    manifest,
    source,
    entryStyles: [],
    warnings: [...result.warnings],
  }
  const errors: string[] = []

  /** 声明了入口就必须存在；strict 下缺失算错误，否则只警告 */
  const resolve = (field: 'main' | 'renderer' | 'uninstall', relative: string): string | undefined => {
    const entry = resolveEntry(dir, relative)
    if (!entry) {
      const message = `${field} 入口不存在: ${relative}`
      if (strict) errors.push(message)
      else record.warnings.push(`${message}（是否忘记执行 pnpm build:plugins？）`)
    }
    return entry
  }

  if (manifest.main) {
    const entry = resolve('main', manifest.main)
    if (entry) record.entryMain = entry
  }

  if (manifest.renderer) {
    const entry = resolve('renderer', manifest.renderer)
    if (entry) record.entryRenderer = entry
  }

  if (manifest.uninstall) {
    const entry = resolve('uninstall', manifest.uninstall)
    if (entry) record.entryUninstall = entry
  }

  for (const style of manifest.styles ?? []) {
    const entry = resolveEntry(dir, style)
    if (entry) record.entryStyles.push(entry)
    else if (strict) errors.push(`样式文件不存在: ${style}`)
    else record.warnings.push(`样式文件不存在: ${style}`)
  }

  return errors.length ? { errors } : { record, errors }
}

function normalizeRoots(roots: Array<string | PluginRoot>): PluginRoot[] {
  return roots.map((root) => (typeof root === 'string' ? { dir: root, source: 'builtin' } : root))
}

/**
 * 扫描若干插件根目录，读取 `<root>/<plugin>/plugin.json`。
 *
 * 根目录按顺序扫描：先扫到的那份胜出。bootstrap 与内核都把内置根放在用户根之前，
 * 因此第三方插件无法用同 id 覆盖内置插件——它会被当作冲突报错。
 */
export async function scanPlugins(roots: Array<string | PluginRoot>): Promise<ScanResult> {
  const plugins: PluginRecord[] = []
  const errors: ScanError[] = []
  const seen = new Map<string, { dir: string; source: PluginSource }>()

  for (const root of normalizeRoots(roots)) {
    if (!existsSync(root.dir)) continue
    let dirents
    try {
      dirents = await readdir(root.dir, { withFileTypes: true })
    } catch (error) {
      errors.push({ dir: root.dir, errors: [`无法读取插件目录: ${(error as Error).message}`] })
      continue
    }

    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory()) continue
      // 安装暂存目录以 `.` 开头，永远不是一个可加载的插件
      if (dirent.name.startsWith('.')) continue
      const dir = path.join(root.dir, dirent.name)

      const { record, errors: directoryErrors } = await readPluginDirectory(dir, root.source)
      if (!record) {
        errors.push({ dir, errors: directoryErrors.length ? directoryErrors : ['清单无效'] })
        continue
      }

      const previous = seen.get(record.manifest.id)
      if (previous) {
        errors.push({
          dir,
          errors: [
            previous.source === 'builtin'
              ? `插件 id ${record.manifest.id} 属于内置插件，第三方插件不能覆盖（${previous.dir}）`
              : `插件 id ${record.manifest.id} 与 ${previous.dir} 重复`,
          ],
        })
        continue
      }
      seen.set(record.manifest.id, { dir, source: record.source })
      plugins.push(record)
    }
  }

  return { plugins, errors }
}

/** 以 ESM 方式载入插件入口（带 cache-busting，便于后续热重载） */
export async function importPluginEntry(entry: string): Promise<Record<string, unknown>> {
  const url = `${pathToFileURL(entry).href}?mics=${Date.now()}`
  const module = await import(url)
  return module as Record<string, unknown>
}
