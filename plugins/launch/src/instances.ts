import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { InstanceSummary } from './shared'
import type { VersionJson } from './version'

interface InstanceMetadata {
  name?: string
  lastPlayed?: number
  lastVersion?: string
  username?: string
}

export interface ResolvedInstance {
  id: string
  name: string
  dir: string
  versionDir: string
  version: VersionJson
  metadataPath: string
  metadata: InstanceMetadata
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

function versionJsonIn(versionDir: string): { version: VersionJson; file: string } | null {
  if (!existsSync(versionDir)) return null
  const preferred = path.join(versionDir, `${path.basename(versionDir)}.json`)
  const files = readdirSync(versionDir).filter((file) => file.toLowerCase().endsWith('.json'))
  const ordered = existsSync(preferred)
    ? [preferred, ...files.filter((file) => file !== path.basename(preferred)).map((file) => path.join(versionDir, file))]
    : files.map((file) => path.join(versionDir, file))

  for (const file of ordered) {
    const version = readJson<VersionJson>(file)
    if (version?.id && version.mainClass) return { version, file }
  }
  return null
}

function resolveVersion(instanceDir: string, preferredVersion?: string): { versionDir: string; version: VersionJson } | null {
  const versionsDir = path.join(instanceDir, 'versions')
  if (!existsSync(versionsDir)) return null

  const candidates: Array<{ dir: string; mtime: number; version: VersionJson }> = []
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const versionDir = path.join(versionsDir, entry.name)
    const found = versionJsonIn(versionDir)
    if (!found) continue
    let mtime = 0
    try {
      mtime = statSync(found.file).mtimeMs
    } catch { /* ignore */ }
    candidates.push({ dir: versionDir, mtime, version: found.version })
  }

  if (candidates.length === 0) return null
  if (preferredVersion) {
    const preferred = candidates.find((candidate) => candidate.version.id === preferredVersion)
    if (preferred) return { versionDir: preferred.dir, version: preferred.version }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const chosen = candidates[0]!
  return { versionDir: chosen.dir, version: chosen.version }
}

export function loaderLabel(version: VersionJson): string {
  if (!version.inheritsFrom) return '原版'
  const id = version.id.toLowerCase()
  if (id.includes('neoforge')) return 'NeoForge'
  if (id.includes('fabric')) return 'Fabric'
  if (id.includes('quilt')) return 'Quilt'
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

function toSummary(instance: ResolvedInstance): InstanceSummary {
  return {
    id: instance.id,
    name: instance.name,
    minecraft: instance.version.inheritsFrom ?? instance.version.id,
    loader: loaderLabel(instance.version),
    mods: countMods(instance.dir),
    lastPlayed: instance.metadata.lastPlayed ?? null,
    versionId: instance.version.id,
  }
}

export function resolveInstance(userDataDir: string, id: string): ResolvedInstance | null {
  if (!isSafeInstanceId(id)) return null
  const instanceDir = path.join(userDataDir, 'instances', id)
  if (!existsSync(instanceDir)) return null

  const { metadataPath, metadata } = readMetadata(instanceDir)
  const resolved = resolveVersion(instanceDir, metadata.lastVersion)
  if (!resolved) return null

  return {
    id,
    name: metadata.name?.trim() || id,
    dir: instanceDir,
    versionDir: resolved.versionDir,
    version: resolved.version,
    metadataPath,
    metadata,
  }
}

export function listInstances(userDataDir: string): InstanceSummary[] {
  const root = path.join(userDataDir, 'instances')
  if (!existsSync(root)) return []

  const summaries: InstanceSummary[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const instance = resolveInstance(userDataDir, entry.name)
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
    username,
  }
  writeFileSync(instance.metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}
