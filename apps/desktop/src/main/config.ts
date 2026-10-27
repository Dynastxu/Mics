import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppInfo } from '@mics/sdk'


export interface BootConfig {
  /** 内核插件 id；bootstrap 只认识它 */
  kernel: string
  /** 插件根目录，相对仓库/资源根目录 */
  pluginRoots: string[]
  /** 需要禁用的插件 id */
  disabled: string[]
}

const DEFAULT_CONFIG: BootConfig = {
  kernel: 'mics.kernel',
  pluginRoots: ['plugins'],
  disabled: [],
}

/** 仓库根目录（开发态）：apps/desktop/out/main -> mics */
function projectRoot(): string {
  return process.env.MICS_PROJECT_ROOT ?? path.resolve(app.getAppPath(), '../..')
}

function configCandidates(): string[] {
  if (app.isPackaged) return [path.join(process.resourcesPath, 'boot.config.json')]
  return [
    path.join(projectRoot(), 'boot.config.json'),
    path.join(process.cwd(), 'boot.config.json'),
  ]
}

export function loadBootConfig(): BootConfig {
  for (const file of configCandidates()) {
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BootConfig>
      return {
        kernel: typeof raw.kernel === 'string' && raw.kernel ? raw.kernel : DEFAULT_CONFIG.kernel,
        pluginRoots:
          Array.isArray(raw.pluginRoots) && raw.pluginRoots.length > 0
            ? raw.pluginRoots.filter((item): item is string => typeof item === 'string')
            : DEFAULT_CONFIG.pluginRoots,
        disabled: Array.isArray(raw.disabled)
          ? raw.disabled.filter((item): item is string => typeof item === 'string')
          : [],
      }
    } catch (error) {
      console.warn(`[mics] 读取 ${file} 失败：${(error as Error).message}`)
    }
  }
  return { ...DEFAULT_CONFIG }
}

/** 解析插件根目录；MICS_PLUGIN_ROOTS 可覆盖（多个路径用 path.delimiter 分隔） */
export function resolvePluginRoots(roots: string[]): string[] {
  const override = process.env.MICS_PLUGIN_ROOTS
  if (override) {
    return override
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  const base = app.isPackaged ? process.resourcesPath : projectRoot()
  return roots.map((root) => (path.isAbsolute(root) ? root : path.resolve(base, root)))
}

export function createAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '0',
    chrome: process.versions.chrome ?? '0',
    node: process.versions.node,
    platform: process.platform,
    isDev: !app.isPackaged,
    userDataPath: app.getPath('userData'),
  }
}
