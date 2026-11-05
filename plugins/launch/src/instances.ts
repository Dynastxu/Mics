import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { INSTANCE_STATE_FILE } from '@mics/sdk'
import type { InstanceInstallRecord, InstanceInstallState } from '@mics/sdk'
import { instancesRoot, resolveInstanceLayout } from '@mics/sdk/main'
import type { InstanceLayout } from '@mics/sdk/main'
import type { InstanceSummary } from './shared'
import type { VersionJson } from './version'

interface InstanceMetadata {
  name?: string
  lastPlayed?: number
  lastVersion?: string
  username?: string
}

/**
 * 实例的一份磁盘快照。
 *
 * `versions` 下的每个文件夹都是一个实例：即使下载还没写出版本档案，也要能看到、
 * 删除它。版本档案只决定「能不能启动」，不决定「算不算实例」。
 */
export interface InstanceSnapshot {
  id: string
  name: string
  dir: string
  /** 版本档案路径；实例还没有版本档案时为空 */
  versionFile: string | null
  /** 版本档案；半成品实例为空 */
  version: VersionJson | null
  metadataPath: string
  metadata: InstanceMetadata
  installState: InstanceInstallState
  /** 安装记录里声明的游戏版本；缺少版本档案时用于展示 */
  gameVersion: string | null
}

export interface ResolvedInstance extends InstanceSnapshot {
  versionFile: string
  version: VersionJson
  /** 资源位置（共享的 libraries / assets + 实例内的 natives / log_configs） */
  layout: InstanceLayout
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 实例 id 就是 instances 下的文件夹名，只接受单层、非 . / .. 的路径 */
export function isSafeInstanceId(id: string): boolean {
  return Boolean(id) && id !== '.' && id !== '..' && path.basename(id) === id
}

function readMetadata(instanceDir: string): { metadataPath: string; metadata: InstanceMetadata } {
  const metadataPath = path.join(instanceDir, 'instance.json')
  const metadata = readJson<InstanceMetadata>(metadataPath) ?? {}
  return { metadataPath, metadata }
}

/**
 * 读取实例的安装状态。
 *
 * 下载管线在实例目录里写 `installing` / `ready`；没有这个文件的实例来自
 * 更早的版本，按 `ready` 处理以保持兼容。没有版本档案的实例无论标记如何都
 * 不能启动，统一按 `installing` 展示，让启动页提供补全或删除入口。
 */
function installStateOf(
  version: VersionJson | null,
  record: InstanceInstallRecord | null
): InstanceInstallState {
  if (!version) return 'installing'
  return record?.state === 'installing' ? 'installing' : 'ready'
}

/**
 * 找实例里的版本档案。
 *
 * 实例目录就是版本目录：`<版本 id>.json` 与客户端 jar 平铺在根下（相当于 PCL
 * 版本隔离后的 `versions/<版本>`）。根下还有 `instance.json`、`install-state.json`
 * 这类元数据，用「有 id 且 mainClass」把它们排除掉。
 */
function resolveVersion(
  instanceDir: string,
  preferredVersion?: string
): { file: string; version: VersionJson } | null {
  let entries: string[]
  try {
    entries = readdirSync(instanceDir)
  } catch {
    return null
  }

  const candidates: Array<{ file: string; mtime: number; version: VersionJson }> = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    const file = path.join(instanceDir, entry)
    const version = readJson<VersionJson>(file)
    if (!version?.id || !version.mainClass) continue
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      /* ignore */
    }
    candidates.push({ file, mtime, version })
  }

  if (candidates.length === 0) return null
  if (preferredVersion) {
    const preferred = candidates.find((candidate) => candidate.version.id === preferredVersion)
    if (preferred) return { file: preferred.file, version: preferred.version }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const chosen = candidates[0]!
  return { file: chosen.file, version: chosen.version }
}

export function loaderLabel(version: VersionJson): string {
  if (!version.inheritsFrom) return '原版'
  const id = version.id.toLowerCase()
  if (id.includes('neoforge')) return 'NeoForge'
  if (id.includes('quilt')) return 'Quilt'
  if (id.includes('fabric')) return 'Fabric'
  if (id.includes('forge')) return 'Forge'
  return 'Mod 加载器'
}

/** 已启用的 Mod 数量（.jar.disabled 不计入，与启动页徽标一致） */
export function countMods(instanceDir: string): number {
  const modsDir = path.join(instanceDir, 'mods')
  if (!existsSync(modsDir)) return 0
  try {
    return readdirSync(modsDir).filter((file) => file.toLowerCase().endsWith('.jar')).length
  } catch {
    return 0
  }
}

function toSummary(instance: InstanceSnapshot): InstanceSummary {
  const version = instance.version
  return {
    id: instance.id,
    name: instance.name,
    minecraft: version ? (version.inheritsFrom ?? version.id) : (instance.gameVersion ?? '未知'),
    loader: version ? loaderLabel(version) : '未知',
    mods: countMods(instance.dir),
    lastPlayed: instance.metadata.lastPlayed ?? null,
    versionId: version?.id ?? '',
    installState: instance.installState
  }
}

/**
 * 读取实例快照；只要 `versions/<id>` 是文件夹就算实例，不要求版本档案存在。
 * 目录不存在或不是文件夹时返回 null。
 */
export function discoverInstance(userDataDir: string, id: string): InstanceSnapshot | null {
  if (!isSafeInstanceId(id)) return null
  const instanceDir = path.join(instancesRoot(userDataDir), id)

  try {
    if (!statSync(instanceDir).isDirectory()) return null
  } catch {
    return null
  }

  const { metadataPath, metadata } = readMetadata(instanceDir)
  const record = readJson<InstanceInstallRecord>(path.join(instanceDir, INSTANCE_STATE_FILE))
  const resolved = resolveVersion(instanceDir, metadata.lastVersion)

  return {
    id,
    name: metadata.name?.trim() || id,
    dir: instanceDir,
    versionFile: resolved?.file ?? null,
    version: resolved?.version ?? null,
    metadataPath,
    metadata,
    installState: installStateOf(resolved?.version ?? null, record),
    gameVersion: record?.gameVersion ?? null
  }
}

/** 可启动的实例：除目录外还必须能找到版本档案 */
export function resolveInstance(userDataDir: string, id: string): ResolvedInstance | null {
  const instance = discoverInstance(userDataDir, id)
  if (!instance?.version || !instance.versionFile) return null

  return {
    ...instance,
    version: instance.version,
    versionFile: instance.versionFile,
    layout: resolveInstanceLayout(userDataDir, instance.dir)
  }
}

export function listInstances(userDataDir: string): InstanceSummary[] {
  const root = instancesRoot(userDataDir)
  if (!existsSync(root)) return []

  const summaries: InstanceSummary[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const instance = discoverInstance(userDataDir, entry.name)
    if (instance) summaries.push(toSummary(instance))
  }

  return summaries.sort((a, b) => {
    const played = (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)
    return played !== 0 ? played : a.name.localeCompare(b.name, 'zh-CN')
  })
}

export function markInstanceLaunched(instance: ResolvedInstance, username: string): void {
  const metadata: InstanceMetadata = {
    ...instance.metadata,
    lastPlayed: Date.now(),
    lastVersion: instance.version.id,
    username
  }
  writeFileSync(instance.metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}
