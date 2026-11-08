import {
  PATH_VARIABLES,
  isLegacyPermission,
  type ExecPermission,
  type OsPermissions,
  type PluginPermissions,
  type TrustLevel
} from '@mics/sdk'

/**
 * 清单里 `permissions` 的解析与校验。
 *
 * 两种写法：
 *   - v1：`["shell:openExternal"]` —— 归一化成 `trust: "full"` + `os.*`；
 *   - v2：结构化对象。
 *
 * 归一化在后，运行时只认 `PluginPermissions`，不再区分版本。
 */

const TRUST_LEVELS: ReadonlySet<string> = new Set<TrustLevel>(['full', 'sandboxed'])
const NET_MODES = new Set(['none', 'allowlist', 'all'])
const CLIPBOARD = new Set(['none', 'write', 'read'])
const DIALOGS = new Set(['none', 'open', 'save'])
const KNOWN_KEYS = new Set(['trust', 'fs', 'exec', 'net', 'os'])
const SCOPE_KEYS = new Set(['read', 'write', 'meta'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 目录声明：绝对路径或以 `${变量}` 开头，不允许 `..`，不允许段内通配 */
function scopePathError(value: string): string | undefined {
  if (!value.trim()) return '路径不能为空'
  if (value.includes('\0')) return '路径不能包含 NUL 字节'

  const trimmed = value.replace(/[\\/]\*\*$/, '')
  if (/[*?]/.test(trimmed)) return '只支持目录，不支持段内通配（可以用末尾的 /**）'
  if (trimmed.split(/[\\/]+/).includes('..')) return '路径不能包含 ..'

  const absolute =
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('/')
  if (!absolute && !trimmed.startsWith('${')) {
    return '必须是绝对路径，或以 ${userData} / ${pluginDir} 这类变量开头'
  }
  return undefined
}

function collectVariables(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string')
}

/** v1 数组 → v2 对象 */
function fromLegacy(raw: unknown[], warnings: string[], context: string): PluginPermissions {
  const os: OsPermissions = {}
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      warnings.push(`${context}：permissions 里的条目不是字符串，已忽略`)
      continue
    }
    if (!isLegacyPermission(entry)) {
      warnings.push(`${context}：未知的权限 "${entry}"，已忽略`)
      continue
    }
    switch (entry) {
      case 'shell:openExternal':
        os.openExternal = true
        break
      case 'dialog:open':
        os.dialogs = 'open'
        break
      case 'clipboard:write':
        os.clipboard = 'write'
        break
      case 'notifications:show':
        os.notifications = true
        break
    }
  }
  // v1 插件今天就跑在主进程里，降级会改变行为，所以显式标成 full
  return { trust: 'full', os }
}

function parseScope(
  raw: unknown,
  field: string,
  errors: string[],
  warnings: string[]
): string[] | undefined {
  if (raw === undefined) return undefined
  if (!isStringArray(raw)) {
    errors.push(`permissions.fs.${field} 必须是字符串数组`)
    return undefined
  }
  for (const value of raw) {
    const problem = scopePathError(value)
    if (problem) {
      errors.push(`permissions.fs.${field} 的 "${value}"：${problem}`)
      continue
    }
    for (const name of collectVariables(value)) {
      if (!(PATH_VARIABLES as readonly string[]).includes(name)) {
        warnings.push(`permissions.fs.${field} 使用了未知变量 \${${name}}，运行时不会被展开`)
      }
    }
  }
  return [...raw]
}

function parseExec(raw: unknown, errors: string[]): ExecPermission[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    errors.push('permissions.exec 必须是数组')
    return undefined
  }
  const rules: ExecPermission[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.bin !== 'string' || !item.bin.trim()) {
      errors.push('permissions.exec 条目需要非空的 bin')
      continue
    }
    if (item.args !== undefined && !isStringArray(item.args)) {
      errors.push(`permissions.exec 的 ${item.bin} 的 args 必须是字符串数组`)
      continue
    }
    if (item.args) {
      let valid = true
      for (const pattern of item.args) {
        try {
          new RegExp(pattern)
        } catch {
          errors.push(`permissions.exec 的 ${item.bin} 的 args 里有非法正则：${pattern}`)
          valid = false
        }
      }
      if (!valid) continue
    }
    rules.push({ bin: item.bin, args: item.args ? [...item.args] : undefined })
  }
  return rules
}

function parseNet(
  raw: unknown,
  trust: TrustLevel,
  errors: string[]
): PluginPermissions['net'] {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    errors.push('permissions.net 必须是对象')
    return undefined
  }
  if (typeof raw.mode !== 'string' || !NET_MODES.has(raw.mode)) {
    errors.push('permissions.net.mode 必须是 none / allowlist / all')
    return undefined
  }
  const mode = raw.mode as 'none' | 'allowlist' | 'all'
  const hosts = raw.hosts
  if (hosts !== undefined && !isStringArray(hosts)) {
    errors.push('permissions.net.hosts 必须是字符串数组')
    return undefined
  }
  if (mode === 'allowlist' && (!hosts || hosts.length === 0)) {
    errors.push('permissions.net.mode = "allowlist" 时必须给出 hosts')
  }
  for (const host of hosts ?? []) {
    if (!host.trim()) errors.push('permissions.net.hosts 里有空白的域名')
    if (host.trim() === '*' && mode !== 'all') {
      errors.push('通配域名 "*" 只允许出现在 net.mode = "all" 里')
    }
  }
  if (mode === 'all' && trust !== 'full') {
    errors.push('net.mode = "all" 只允许与 trust = "full" 搭配')
  }
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) errors.push('permissions.net.ports 必须是整数数组')
    else {
      for (const port of raw.ports) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`permissions.net.ports 里的 ${String(port)} 不是合法端口`)
        }
      }
    }
  }
  for (const flag of ['allowPlainHttp', 'allowPrivate'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      errors.push(`permissions.net.${flag} 必须是布尔值`)
    }
  }
  return {
    mode,
    hosts: hosts ? [...hosts] : undefined,
    ports: Array.isArray(raw.ports) ? (raw.ports as number[]) : undefined,
    allowPlainHttp: raw.allowPlainHttp === true,
    allowPrivate: raw.allowPrivate === true
  }
}

function parseOs(raw: unknown, errors: string[]): OsPermissions | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    errors.push('permissions.os 必须是对象')
    return undefined
  }
  for (const flag of ['openExternal', 'notifications'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      errors.push(`permissions.os.${flag} 必须是布尔值`)
    }
  }
  if (raw.clipboard !== undefined && !CLIPBOARD.has(String(raw.clipboard))) {
    errors.push('permissions.os.clipboard 必须是 none / write / read')
  }
  if (raw.dialogs !== undefined && !DIALOGS.has(String(raw.dialogs))) {
    errors.push('permissions.os.dialogs 必须是 none / open / save')
  }
  return {
    openExternal: raw.openExternal === true,
    notifications: raw.notifications === true,
    clipboard: raw.clipboard as OsPermissions['clipboard'],
    dialogs: raw.dialogs as OsPermissions['dialogs']
  }
}

/**
 * 校验并归一化 `permissions`。
 *
 * - 缺省 → `{ trust: "full" }`（保持今天的行为）；
 * - 数组 → v1 兼容；
 * - 对象 → v2，未知字段报错（防拼写错误），未知变量只警告。
 */
export function validatePermissions(
  raw: unknown,
  errors: string[],
  warnings: string[],
  context = 'permissions'
): PluginPermissions | undefined {
  if (raw === undefined) return { trust: 'full' }
  if (Array.isArray(raw)) return fromLegacy(raw, warnings, context)
  if (!isRecord(raw)) {
    errors.push(`${context} 必须是字符串数组或对象`)
    return undefined
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`${context} 里有未知字段 "${key}"`)
    }
  }

  const trustRaw = raw.trust ?? 'sandboxed'
  if (typeof trustRaw !== 'string' || !TRUST_LEVELS.has(trustRaw)) {
    errors.push(`${context}.trust 必须是 full / isolated / sandboxed`)
    return undefined
  }
  const trust = trustRaw as TrustLevel

  let fs: PluginPermissions['fs']
  if (raw.fs !== undefined) {
    if (!isRecord(raw.fs)) {
      errors.push(`${context}.fs 必须是对象`)
    } else {
      for (const key of Object.keys(raw.fs)) {
        if (!SCOPE_KEYS.has(key)) errors.push(`${context}.fs 里有未知字段 "${key}"`)
      }
      fs = {
        read: parseScope(raw.fs.read, 'read', errors, warnings),
        write: parseScope(raw.fs.write, 'write', errors, warnings),
        meta: parseScope(raw.fs.meta, 'meta', errors, warnings)
      }
    }
  }

  return {
    trust,
    fs,
    exec: parseExec(raw.exec, errors),
    net: parseNet(raw.net, trust, errors),
    os: parseOs(raw.os, errors)
  }
}
