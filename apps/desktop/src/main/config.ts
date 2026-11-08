import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AppInfo, ProfileConfig, SandboxMode } from '@mics/sdk'

export interface BootConfig {
  /** 内核插件 id；bootstrap 只认识它 */
  kernel: string
  /** 插件根目录，相对仓库/资源根目录 */
  pluginRoots: string[]
  /** 需要禁用的插件 id */
  disabled: string[]
  /** 部署 profile 名；对应 userData/profiles/<name>.json */
  profile?: string
  /** 沙箱模式；缺省 off（插件全部跑在主进程） */
  sandbox?: SandboxMode
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
  disabled: []
}

/** 仓库根目录（开发态）：apps/desktop/out/main -> mics */
function projectRoot(): string {
  return process.env.MICS_PROJECT_ROOT ?? path.resolve(app.getAppPath(), '../..')
}

function configCandidates(): string[] {
  if (app.isPackaged) return [path.join(process.resourcesPath, 'boot.config.json')]
  return [
    path.join(projectRoot(), 'boot.config.json'),
    path.join(process.cwd(), 'boot.config.json')
  ]
}

/**
 * 解析沙箱开关。
 *
 * 只认 `on` / `off`（也接受 `true` / `false`）。
 * `audit` / `enforce` 是旧写法：两者都按 `on` 处理——权限强制现在只由插件的
 * `trust` 决定，与这个开关无关。
 */
function parseSandbox(value: unknown, onWarning: ConfigWarning): SandboxMode | undefined {
  if (value === undefined) return undefined
  if (value === 'on' || value === true) return 'on'
  if (value === 'off' || value === false) return 'off'
  if (value === 'audit' || value === 'enforce') {
    onWarning(`sandbox: "${value}" 已废弃，按 "on" 处理；强制程度由插件的 trust 决定`)
    return 'on'
  }
  onWarning(`sandbox 只接受 "on" / "off"，收到 ${JSON.stringify(value)}，按 off 处理`)
  return 'off'
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
        sandbox: parseSandbox(raw.sandbox, onWarning)
      }
    } catch (error) {
      onWarning(`读取 ${file} 失败：${(error as Error).message}`)
    }
  }
  return { ...DEFAULT_CONFIG }
}

/** 解析插件根目录；MICS_PLUGIN_ROOTS 可覆盖（多个路径用 path.delimiter 分隔） */
export function resolvePluginRoots(roots: string[]): string[] {
  const base = app.isPackaged ? process.resourcesPath : projectRoot()
  // 覆盖值也要按仓库根解析：开发时进程 cwd 是 apps/desktop，
  // 直接拿相对的 "plugins" 去扫会一个都找不到（内核缺失 → 应用起不来）。
  const resolve = (root: string): string =>
    path.isAbsolute(root) ? root : path.resolve(base, root)

  const override = process.env.MICS_PLUGIN_ROOTS
  if (override) {
    return override
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(resolve)
  }
  return roots.map(resolve)
}

/**
 * 读取部署 profile。
 *
 * profile 文件缺失或字段不合法时不让应用启动失败：记一条告警并退回空 profile，
 * 这样一次手滑不会把整个界面锁死。`enable` / `disable` 只接受字符串数组，
 * `settings` 只接受 `{ [pluginId]: { [key]: value } }`。
 */
export function loadProfile(
  name: string,
  onWarning: ConfigWarning = consoleWarning
): ProfileConfig {
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
      if (
        !record.settings ||
        typeof record.settings !== 'object' ||
        Array.isArray(record.settings)
      ) {
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
      settings
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
    profile
  }
}
