import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { PackKind } from '../contract/mod'
import { INVALID_INSTANCE_NAME_TEST, validateInstanceName } from '../contract/instance'
import { instancesRoot } from './layout'

/**
 * 资源包 / 光影包 / 数据包的安装目标解析。
 *
 * 三类页面各自是独立插件，但「目标目录在实例里 / 数据包必须指定存档」的规则
 * 只有一份：写错一次就会把文件放到实例根或别的存档里。
 */

/** 资源包 / 光影包在实例里的落盘目录；数据包按存档写 */
export const PACK_DIRS: Record<Exclude<PackKind, 'datapack'>, string> = {
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks'
}

export interface PackInstallTarget {
  instanceName: string
  target: string
  /** 下载开始前必须仍然存在的目录 */
  guardDir: string
  detail: string
}

export interface PackTargets {
  targets: PackInstallTarget[]
  /** 下载页副标题 */
  detail: string
}

/** 存档名只接受 `saves/` 下的单层文件夹名 */
export function safeWorldName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name === '.' || name === '..') return null
  if (path.basename(name) !== name) return null
  return INVALID_INSTANCE_NAME_TEST.test(name) ? null : name
}

/** 单层文件名校验：文件名会直接拼进实例目录 */
export function safePackFileName(value: unknown, extension: RegExp): string | null {
  if (typeof value !== 'string') return null
  const name = path.basename(value)
  if (!name || name !== value || !extension.test(name)) return null
  return INVALID_INSTANCE_NAME_TEST.test(name) ? null : name
}

export function resolvePackTargets(
  userDataDir: string,
  kind: PackKind,
  instanceNames: string[],
  fileName: string,
  worldName?: string | null
): PackTargets {
  const names = [...new Set(instanceNames)]
  if (names.length === 0) throw new Error('请选择至少一个实例')
  if (kind === 'datapack' && names.length !== 1) {
    throw new Error('数据包一次只能安装到一个存档')
  }
  if (names.length > 64) throw new Error('一次最多安装到 64 个实例')

  const world = kind === 'datapack' ? safeWorldName(worldName) : null
  if (kind === 'datapack' && !world) throw new Error('请选择一个存档')

  const targets: PackInstallTarget[] = []
  for (const instanceName of names) {
    const check = validateInstanceName(instanceName)
    if (!check.ok || check.name !== instanceName) {
      throw new Error(`无效的实例名称：${instanceName}`)
    }
    const instanceDir = path.join(instancesRoot(userDataDir), instanceName)
    if (!existsSync(instanceDir) || !statSync(instanceDir).isDirectory()) {
      throw new Error(`实例「${instanceName}」不存在`)
    }

    if (kind === 'datapack') {
      const worldDir = path.join(instanceDir, 'saves', world!)
      if (!existsSync(worldDir) || !statSync(worldDir).isDirectory()) {
        throw new Error(`实例「${instanceName}」里没有存档「${world}」`)
      }
      targets.push({
        instanceName,
        target: path.join(worldDir, 'datapacks', fileName),
        guardDir: worldDir,
        detail: `${instanceName} · ${world}`
      })
      continue
    }

    targets.push({
      instanceName,
      target: path.join(instanceDir, PACK_DIRS[kind], fileName),
      guardDir: instanceDir,
      detail: instanceName
    })
  }

  return {
    targets,
    detail: kind === 'datapack' ? targets[0]!.detail : `${targets.length} 个实例`
  }
}
