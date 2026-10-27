import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginRecord, ScanError, ScanResult } from '@mics/sdk'
import { isSafeRelativePath, validateManifest } from './manifest'

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

/** 扫描若干插件根目录，读取 <root>/<plugin>/plugin.json */
export async function scanPlugins(roots: string[]): Promise<ScanResult> {
  const plugins: PluginRecord[] = []
  const errors: ScanError[] = []
  const seen = new Map<string, string>()

  for (const root of roots) {
    if (!existsSync(root)) continue
    let dirents
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      errors.push({ dir: root, errors: [`无法读取插件目录: ${(error as Error).message}`] })
      continue
    }

    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory()) continue
      const dir = path.join(root, dirent.name)
      const manifestFile = path.join(dir, 'plugin.json')
      if (!existsSync(manifestFile)) continue

      let raw: unknown
      try {
        raw = JSON.parse(await readFile(manifestFile, 'utf8'))
      } catch (error) {
        errors.push({ dir, errors: [`plugin.json 解析失败: ${(error as Error).message}`] })
        continue
      }

      const result = validateManifest(raw)
      if (!result.manifest || result.errors.length > 0) {
        errors.push({ dir, errors: result.errors.length ? result.errors : ['清单无效'] })
        continue
      }

      const manifest = result.manifest
      if (seen.has(manifest.id)) {
        errors.push({ dir, errors: [`插件 id ${manifest.id} 与 ${seen.get(manifest.id)} 重复`] })
        continue
      }
      seen.set(manifest.id, dir)

      const record: PluginRecord = {
        dir,
        manifest,
        entryStyles: [],
        warnings: [...result.warnings],
      }

      if (manifest.main) {
        const entry = resolveEntry(dir, manifest.main)
        if (entry) record.entryMain = entry
        else record.warnings.push(`main 入口不存在: ${manifest.main}（是否忘记执行 pnpm build:plugins？）`)
      }

      if (manifest.renderer) {
        const entry = resolveEntry(dir, manifest.renderer)
        if (entry) record.entryRenderer = entry
        else record.warnings.push(`renderer 入口不存在: ${manifest.renderer}`)
      }

      for (const style of manifest.styles ?? []) {
        const entry = resolveEntry(dir, style)
        if (entry) record.entryStyles.push(entry)
        else record.warnings.push(`样式文件不存在: ${style}`)
      }

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
