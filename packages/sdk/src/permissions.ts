import type {
  ExecPermission,
  FsPermissions,
  LegacyPermission,
  NetPermissions,
  OsPermissions,
  PluginPermissions,
  TrustLevel
} from './contract/manifest'

/**
 * 权限的解析与查询。
 *
 * 这里只做「把声明变成可展示、可比较的形状」，不碰文件系统——渲染进程也会
 * import 这个模块，所以不能依赖 `node:path`。
 */

/** 路径变量；缺省的变量会留在 `unresolved` 里，由界面提示 */
export interface PermissionVariables {
  userData?: string
  pluginDir?: string
  temp?: string
  home?: string
}

export interface ResolvedPathScope {
  declared: string[]
  resolved: string[]
  unresolved: string[]
}

export interface ResolvedFsPermissions {
  read: ResolvedPathScope
  write: ResolvedPathScope
  meta: ResolvedPathScope
}

export interface ResolvedPermissions {
  trust: TrustLevel
  fs: ResolvedFsPermissions
  exec: ExecPermission[]
  net?: NetPermissions
  os?: OsPermissions
  /** 因变量缺失而没能展开的声明；非空说明清单写错了变量名 */
  unresolved: string[]
}

const LEGACY_PERMISSIONS: ReadonlySet<string> = new Set<LegacyPermission>([
  'shell:openExternal',
  'dialog:open',
  'clipboard:write',
  'notifications:show'
])

export function isLegacyPermission(value: string): value is LegacyPermission {
  return LEGACY_PERMISSIONS.has(value)
}

/** 已知的路径变量名（与 `PermissionVariables` 的键一一对应） */
export const PATH_VARIABLES = ['userData', 'pluginDir', 'temp', 'home'] as const

const VARIABLE_PATTERN = /\$\{([A-Za-z0-9_.-]+)\}/g

function resolveScope(
  declared: string[] | undefined,
  variables: PermissionVariables,
  unresolved: Set<string>
): ResolvedPathScope {
  const scope: ResolvedPathScope = { declared: [], resolved: [], unresolved: [] }
  for (const entry of declared ?? []) {
    scope.declared.push(entry)
    let failed = false
    const resolved = entry.replace(VARIABLE_PATTERN, (all: string, name: string) => {
      const value = variables[name as keyof PermissionVariables]
      if (!value) {
        failed = true
        return all
      }
      return value
    })
    if (failed) {
      scope.unresolved.push(entry)
      unresolved.add(entry)
      continue
    }
    // 去掉末尾的分隔符与 `/**`：引擎侧只认目录前缀
    scope.resolved.push(resolved.replace(/[\\/]+$/, '').replace(/[\\/]\*\*$/, ''))
  }
  return scope
}

export function resolvePermissions(
  permissions: PluginPermissions | undefined,
  variables: PermissionVariables
): ResolvedPermissions {
  const unresolved = new Set<string>()
  const fs = permissions?.fs
  return {
    trust: permissions?.trust ?? 'full',
    fs: {
      read: resolveScope(fs?.read, variables, unresolved),
      write: resolveScope(fs?.write, variables, unresolved),
      meta: resolveScope(fs?.meta, variables, unresolved)
    },
    exec: permissions?.exec ?? [],
    net: permissions?.net,
    os: permissions?.os,
    unresolved: [...unresolved]
  }
}

/**
 * 把 v1 的能力字符串翻译成 v2 声明上的判断。
 *
 * `ctx.permissions.has('shell:openExternal')` 这类既有调用点靠它继续工作。
 */
export function allowsLegacy(permissions: PluginPermissions | undefined, legacy: string): boolean {
  const os = permissions?.os
  switch (legacy) {
    case 'shell:openExternal':
      return os?.openExternal === true
    case 'dialog:open':
      return os?.dialogs === 'open' || os?.dialogs === 'save'
    case 'clipboard:write':
      return os?.clipboard === 'write' || os?.clipboard === 'read'
    case 'notifications:show':
      return os?.notifications === true
    default:
      return false
  }
}

/** 权限声明的可读标题，界面和日志共用一份 */
export function trustLabel(trust: TrustLevel): string {
  switch (trust) {
    case 'full':
      return '完全权限'
    case 'sandboxed':
      return '受限权限'
  }
}
