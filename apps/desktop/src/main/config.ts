import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppInfo, ProfileConfig } from '@mics/sdk'


export interface BootConfig {
  /** 内核插件 id；bootstrap 只认识它 */
  kernel: string
  /** 插件根目录，相对仓库/资源根目录 */
  pluginRoots: string[]
  /** 需要禁用的插件 id */
  disabled: string[]
  /** 部署 profile 名；对应 userData/profiles/<name>.json */
  profile?: string
}

/**
 * 启动配置有问题时的去向。
 *
 * 配置解析是纯函数，不应该自己决定写控制台还是写文件；bootstrap 传入日志器，
 * 这些告警就能进入本次启动的日志文件（早于日志插件的部分由缓冲区补录）。
 */
export type ConfigWarning = (message: string) => void

const consoleWarning: ConfigWarning = (message) => {
  console.warn(`[mics] ${message}`)
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

export function loadBootConfig(onWarning: ConfigWarning = consoleWarning): BootConfig {
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
        profile: typeof raw.profile === 'string' && raw.profile ? raw.profile : undefined,
      }
    } catch (error) {
      onWarning(`读取 ${file} 失败：${(error as Error).message}`)
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

/**
 * 读取部署 profile。
 *
 * profile 文件缺失或字段不合法时不让应用启动失败：记一条告警并退回空 profile，
 * 这样一次手滑不会把整个界面锁死。`enable` / `disable` 只接受字符串数组，
 * `settings` 只接受 `{ [pluginId]: { [key]: value } }`。
 */
export function loadProfile(name: string, onWarning: ConfigWarning = consoleWarning): ProfileConfig {
  const empty: ProfileConfig = { name, enable: [], disable: [], settings: {} }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    onWarning(`profile 名不合法：${name}`)
    return empty
  }
  const file = path.join(app.getPath('userData'), 'profiles', `${name}.json`)
  if (!existsSync(file)) {
    onWarning(`profile ${name} 不存在：${file}`)
    return empty
  }

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      onWarning(`profile ${name} 必须是 JSON 对象`)
      return empty
    }
    const record = raw as Record<string, unknown>
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

    const settings: Record<string, Record<string, unknown>> = {}
    if (record.settings !== undefined) {
      if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
        onWarning(`profile ${name} 的 settings 必须是对象`)
      } else {
        for (const [pluginId, values] of Object.entries(record.settings)) {
          if (!values || typeof values !== 'object' || Array.isArray(values)) {
            onWarning(`profile ${name} 的 settings.${pluginId} 必须是对象`)
            continue
          }
          settings[pluginId] = values as Record<string, unknown>
        }
      }
    }

    return {
      name,
      enable: ids(record.enable),
      disable: ids(record.disable),
      settings,
    }
  } catch (error) {
    onWarning(`读取 profile ${name} 失败：${(error as Error).message}`)
    return empty
  }
}

export function createAppInfo(profile?: string): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '0',
    chrome: process.versions.chrome ?? '0',
    node: process.versions.node,
    platform: process.platform,
    isDev: !app.isPackaged,
    userDataPath: app.getPath('userData'),
    profile,
  }
}
