import type {
  InstanceJavaMode,
  InstanceLaunchSettings,
  LaunchSettings,
  RepeatLaunchBehavior
} from './shared'

/**
 * 启动设置的领域规则：默认值、范围与「输入框文本 → 启动参数」的转换。
 *
 * 这里只放纯函数，主进程（读写 storage）、设置页（默认值）与启动管线
 * （拼参数）共用同一份规则，避免范围夹取和参数拆分在两边各写一套。
 */

/** 与 plugin.json 的 contributes.configuration 保持一致 */
export const MIN_MEMORY_MB = 1024
export const MAX_MEMORY_MB = 32768
export const MIN_WINDOW_SIZE = 320
export const MAX_WINDOW_SIZE = 16384

export const DEFAULT_MAX_MEMORY = 4096
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 720

export const DEFAULT_SETTINGS: LaunchSettings = {
  repeatBehavior: 'prompt',
  maxMemory: DEFAULT_MAX_MEMORY,
  javaPaths: [],
  windowWidth: DEFAULT_WINDOW_WIDTH,
  windowHeight: DEFAULT_WINDOW_HEIGHT,
  jvmArgs: ''
}

/** 实例从未设置过启动项时的默认值：全部跟随全局 */
export const DEFAULT_INSTANCE_SETTINGS: InstanceLaunchSettings = {
  javaMode: 'auto',
  javaPath: '',
  followGlobalJvmArgs: true,
  jvmArgs: '',
  followGlobalWindow: true,
  windowWidth: DEFAULT_WINDOW_WIDTH,
  windowHeight: DEFAULT_WINDOW_HEIGHT
}

/** 路径比较：Windows / macOS 上同一路径的写法差异不应出现两个候选 */
export function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function normalizeRepeatBehavior(value: unknown): RepeatLaunchBehavior {
  return value === 'launch' || value === 'ignore' ? value : 'prompt'
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

/** 数字输入框允许空串：空串按「未填写」处理，回落到默认值而不是夹到下限 */
function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 运行时唯一的夹取点：schema 只管写入，直接调用启动管线时也要拿到合法值 */
export function normalizeMemoryMb(value: unknown): number {
  const parsed = parseNumber(value)
  return parsed !== null ? clampInteger(parsed, MIN_MEMORY_MB, MAX_MEMORY_MB) : DEFAULT_MAX_MEMORY
}

export function normalizeWindowSize(value: unknown, fallback: number): number {
  const parsed = parseNumber(value)
  return parsed !== null ? clampInteger(parsed, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE) : fallback
}

/**
 * 规整候选 Java 路径。
 *
 * 数组不属于清单配置 schema 能表达的类型（与下载源列表一样由插件自己管理），
 * 因此读写两端都用这里兜底：只保留非空字符串，去掉重复项并保持用户顺序。
 */
export function normalizeJavaPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const path = entry.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

/**
 * 把设置里的 JVM 参数字符串拆成数组。
 *
 * 按空白拆分，引号包住的片段保留空格（例如 `"-javaagent:C:\Program Files\x.jar"`）；
 * 未闭合的引号按到字符串末尾处理，不为了一个笔误拒绝启动。
 */
export function parseJvmArgs(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []

  const result: string[] = []
  let current = ''
  let quoted = false
  let started = false

  const flush = (): void => {
    if (!started) return
    result.push(current)
    current = ''
    started = false
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index)
    if (quoted) {
      if (char === '"') {
        quoted = false
        continue
      }
      current += char
      continue
    }
    if (char === '"') {
      quoted = true
      started = true
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
    started = true
  }

  flush()
  return result
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function normalizeInstanceJavaMode(value: unknown): InstanceJavaMode {
  return value === 'specified' ? 'specified' : 'auto'
}

/**
 * 归一化实例级启动设置。
 *
 * 写入端（`instances/settings/set`）与读取端（`instance.json` 可能被手改或来自旧版本）
 * 共用这一份规则：字段缺失 / 类型不对时回落到「跟随全局」，不让一个坏值影响启动。
 */
export function normalizeInstanceSettings(value: unknown): InstanceLaunchSettings {
  const raw = recordOf(value)
  return {
    javaMode: normalizeInstanceJavaMode(raw.javaMode),
    javaPath: typeof raw.javaPath === 'string' ? raw.javaPath.trim() : '',
    followGlobalJvmArgs: raw.followGlobalJvmArgs !== false,
    jvmArgs: typeof raw.jvmArgs === 'string' ? raw.jvmArgs.trim() : '',
    followGlobalWindow: raw.followGlobalWindow !== false,
    windowWidth: normalizeWindowSize(raw.windowWidth, DEFAULT_WINDOW_WIDTH),
    windowHeight: normalizeWindowSize(raw.windowHeight, DEFAULT_WINDOW_HEIGHT)
  }
}
