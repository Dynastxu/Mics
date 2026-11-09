import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  VersionArguments,
  VersionArtifact,
  VersionDetail,
  VersionLibrary,
  VersionRule
} from '../contract/minecraft'

/**
 * 版本档案的纯计算工具。
 *
 * 这里只做字符串/结构处理，不碰网络、不碰下载队列：原版安装、加载器安装、
 * 整合包与补全都复用同一份规则，避免「启动时按 A 规则、下载时按 B 规则」。
 */

/** 平台名（Mojang 的 rules 里用 windows / osx / linux） */
export const OS_NAME =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'

/** 文件名里使用的平台名与 rules 里的 os.name 不完全一致（macos / osx） */
export const FILE_OS_NAME =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

/** 处理器架构名（与 rules 的 os.arch 对齐） */
export const ARCH_NAME =
  process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86'

/** 启动参数里可能用到的特性开关；下载阶段只关心默认值（全部关闭） */
const RULE_FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: true,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false
}

/** maven 坐标 -> 仓库内路径（`group:artifact:version[:classifier]`） */
export function mavenPath(name: string): string {
  const [group, artifact, version, classifier] = name.split(':')
  if (!group || !artifact || !version) return name.replace(/:/g, '/')
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`
}

/** 把仓库基址与相对路径拼成绝对地址；基址为空时返回空串 */
export function joinBase(base: string | undefined, relative: string): string {
  if (!base) return ''
  const trimmed = base.replace(/\/+$/, '')
  const suffix = relative.replace(/^\/+/, '')
  return trimmed ? `${trimmed}/${suffix}` : ''
}

/**
 * 把加载器版本文件里的库补全成带 `downloads.artifact` 的形式。
 *
 * Fabric 的 profile 只给 `name` 与仓库基址，没有 url、sha1、size；
 * 统一补全之后，补全与启动逻辑不需要为加载器写特例。
 */
export function normalizeLoaderLibraries(
  libraries: VersionLibrary[],
  fallbackBase: string
): VersionLibrary[] {
  const normalized: VersionLibrary[] = []
  for (const library of libraries) {
    if (!library || typeof library.name !== 'string' || !library.name) continue
    const artifact = library.downloads?.artifact
    const relative = artifact?.path || mavenPath(library.name)
    const url = artifact?.url || joinBase(library.url ?? fallbackBase, relative)
    normalized.push({
      ...library,
      downloads: {
        ...library.downloads,
        artifact: {
          ...artifact,
          url,
          path: relative,
          // Fabric 的 profile 把 sha1 / size 直接放在库条目上
          sha1: artifact?.sha1 || library.sha1 || '',
          size: artifact?.size ?? library.size ?? 0
        }
      }
    })
  }
  return normalized
}

function mergeLibraryEntry(base: VersionLibrary, next: VersionLibrary): VersionLibrary {
  const downloads =
    base.downloads || next.downloads
      ? {
          ...base.downloads,
          ...next.downloads,
          artifact: next.downloads?.artifact ?? base.downloads?.artifact,
          classifiers: {
            ...base.downloads?.classifiers,
            ...next.downloads?.classifiers
          }
        }
      : undefined
  const natives = base.natives || next.natives ? { ...base.natives, ...next.natives } : undefined

  return {
    ...base,
    ...next,
    name: next.name,
    url: next.url ?? base.url,
    sha1: next.sha1 ?? base.sha1,
    size: next.size ?? base.size,
    rules: next.rules ?? base.rules,
    ...(natives ? { natives } : {}),
    ...(downloads ? { downloads } : {})
  }
}

/**
 * 库的合并键：组:构件[:分类器] + 规则签名。
 *
 * 规则签名不能省：1.16.5 的 LWJGL 3.2.1 只允许 osx，3.2.2 禁止 osx，
 * 两者是同一构件的不同平台变体，必须同时保留；而 log4j 2.8.1 与 2.15.0
 * 规则相同，属于「新版本覆盖旧版本」。
 */
function libraryKey(library: VersionLibrary): string {
  const [group, artifact, , classifier] = library.name.split(':')
  const base =
    !group || !artifact
      ? library.name
      : classifier
        ? `${group}:${artifact}:${classifier}`
        : `${group}:${artifact}`
  return `${base}|${JSON.stringify(library.rules ?? [])}`
}

function libraryVersion(name: string): string {
  return name.split(':')[2] ?? ''
}

/**
 * 合并父版本与加载器版本的库列表。
 *
 * 两个容易踩的点：
 * - Mojang 的版本文件里同名库会出现多次：一次只有 artifact，另一次带
 *   `natives` + `downloads.classifiers`（例如 1.16.5 的 LWJGL）。同一个
 *   `组:构件:分类器` 的条目要合并字段，不能去重，否则 native 会被丢掉。
 * - 子版本常常用**不同版本号**覆盖父版本的同一个构件（Forge 用 log4j 2.15.0
 *   覆盖原版 2.8.1）。同一个 `组:构件` 只能留一份，否则 classpath 里会同时
 *   出现两个 log4j，启动时报 `NoSuchMethodError`。
 */
function mergeLibraries(parent: VersionLibrary[], child: VersionLibrary[]): VersionLibrary[] {
  const order: string[] = []
  const byKey = new Map<string, VersionLibrary>()

  const put = (library: VersionLibrary, source: 'parent' | 'child'): void => {
    if (!library || typeof library.name !== 'string' || !library.name) return
    const key = libraryKey(library)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...library })
      order.push(key)
      return
    }

    // 子版本里的后一个条目优先；父版本与子版本版本号相同时才合并字段
    const existingVersion = libraryVersion(existing.name)
    const nextVersion = libraryVersion(library.name)
    if (existingVersion === nextVersion) {
      byKey.set(key, mergeLibraryEntry(existing, library))
      return
    }
    if (source === 'child' || existingVersion !== nextVersion) {
      byKey.set(key, { ...library })
    }
  }

  for (const library of parent) put(library, 'parent')
  for (const library of child) put(library, 'child')

  return order.map((key) => byKey.get(key)!)
}

/** 去掉完全相同的参数条目；合并过的版本档案再次合并时不能重复追加 */
function uniqueArguments(
  list: Array<string | { rules?: unknown[]; value: string | string[] }>
): Array<string | { rules?: unknown[]; value: string | string[] }> {
  const seen = new Set<string>()
  const result: Array<string | { rules?: unknown[]; value: string | string[] }> = []
  for (const entry of list) {
    const key = typeof entry === 'string' ? `s:${entry}` : `o:${JSON.stringify(entry)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

function mergeArguments(
  parent: VersionArguments | undefined,
  child: VersionArguments | undefined
): VersionArguments | undefined {
  if (!parent && !child) return undefined
  return {
    jvm: uniqueArguments([...(parent?.jvm ?? []), ...(child?.jvm ?? [])]),
    game: uniqueArguments([...(parent?.game ?? []), ...(child?.game ?? [])])
  }
}

/**
 * 去掉客户端 jar 的校验值。
 *
 * 安装器可能替换或改写版本 jar（例如旧版 Forge 会复制一份客户端 jar），
 * 此时不能再按原版 sha1 校验，否则启动前会被当成损坏文件而覆盖掉。
 * 保留下载地址只是为了文件真的缺失时还能补回一份可用的原版 jar。
 */
export function stripClientChecksum(version: VersionDetail): VersionDetail {
  const client = version.downloads?.client
  if (!client?.url) return version
  return {
    ...version,
    downloads: { ...version.downloads, client: { url: client.url } }
  }
}

/**
 * 合并父版本与加载器版本。
 *
 * 加载器版本文件保留 `inheritsFrom`（启动页据此显示加载器），但父版本里的
 * 客户端、依赖库、资源索引与启动参数都会内联进来，因此合成结果是自包含的。
 */
export function mergeVersion(parent: VersionDetail, child: VersionDetail): VersionDetail {
  const argumentsMerged = mergeArguments(parent.arguments, child.arguments)
  return {
    ...parent,
    ...child,
    id: child.id,
    inheritsFrom: child.inheritsFrom ?? parent.id,
    mainClass: child.mainClass ?? parent.mainClass,
    libraries: mergeLibraries(parent.libraries ?? [], child.libraries ?? []),
    ...(argumentsMerged ? { arguments: argumentsMerged } : {}),
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: { ...parent.downloads, ...child.downloads },
    logging: child.logging ?? parent.logging,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    type: child.type ?? parent.type,
    releaseTime: child.releaseTime ?? parent.releaseTime
  }
}

/**
 * 版本文件里的 rules 是否允许当前平台。
 *
 * 安装与补全只应下载本机真正会用到的库：Linux / macOS / arm64 的 native
 * 在 Windows x64 上永远不会进 classpath，下载它们只会放大失败面。
 */
export function rulesAllow(rules: unknown[] | undefined): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const entry of rules) {
    const rule = entry as VersionRule | null
    if (!rule || typeof rule !== 'object') continue
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) continue
      if (rule.os.arch && rule.os.arch !== ARCH_NAME) continue
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) continue
        } catch {
          continue
        }
      }
    }
    if (rule.features) {
      const matched = Object.entries(rule.features).every(
        ([key, value]) => RULE_FEATURES[key] === value
      )
      if (!matched) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

/**
 * native 文件的平台标记是否与当前平台一致。
 *
 * rules 只声明 os.name（windows-arm64 的条目甚至没写 arch），所以还要看
 * 文件名里的 classifier：`-natives-windows-arm64` 在 x64 上装不了，
 * 也不该下载。
 */
export function artifactPlatformMatches(relative: string): boolean {
  const file = path.basename(relative).toLowerCase()
  if (!file.includes('-natives-')) return true
  if (!file.includes(`-natives-${FILE_OS_NAME}`)) return false
  if (file.includes('arm64') && ARCH_NAME !== 'arm64') return false
  if (file.includes('aarch_64') && ARCH_NAME !== 'arm64') return false
  if (file.includes('x86_64') && ARCH_NAME !== 'x86_64') return false
  if (file.includes('-x86') && !file.includes('x86_64') && ARCH_NAME !== 'x86') return false
  return true
}

/**
 * 没有摘要的 jar（例如 Fabric profile 里的 fabric-loader 自身）只能做结构校验。
 *
 * 只看文件头不够：断点续传时服务端忽略 Range 会把完整文件追加到残缺的
 * `.part` 后面，文件仍以 `PK` 开头但中央目录偏移全部错位，启动时报
 * ClassNotFoundException。这里对齐 EOCD、中央目录与首个本地头。
 */
export function isReadableJar(file: string): boolean {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return false
  }
  if (buffer.length < 22) return false

  const start = Math.max(0, buffer.length - 0xffff - 22)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return false

  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0 || cdOffset + 46 > buffer.length) return false
  if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) return false

  const localOffset = buffer.readUInt32LE(cdOffset + 42)
  return localOffset + 4 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50
}

/** 一个构件的绝对下载地址；没有地址时返回空串 */
export function artifactUrl(artifact: VersionArtifact | undefined): string {
  return artifact?.url ?? ''
}
