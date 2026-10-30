/**
 * 版本 JSON 的共享类型与合并工具。
 *
 * 下载管线安装原版时直接用 Mojang 的版本文件；安装加载器时拿到的是
 * 「只声明差异、靠 inheritsFrom 指向原版」的加载器版本文件。本模块把两者
 * 合并成自包含的版本文件：启动与补全只需要读一个文件、一个目录，
 * 不需要在运行期再解析继承关系。
 */

export interface VersionArtifact {
  url?: string
  sha1?: string
  size?: number
  /** maven 仓库内的相对路径 */
  path?: string
}

export interface VersionLibrary {
  name: string
  /** 加载器版本文件里的仓库基址；配合 name 拼出实际下载地址 */
  url?: string
  /** 部分 profile 把摘要/大小放在条目顶层，而不是 downloads.artifact 里 */
  sha1?: string
  size?: number
  downloads?: {
    artifact?: VersionArtifact
    classifiers?: Record<string, VersionArtifact>
  }
  natives?: Record<string, string>
  rules?: unknown[]
}

export interface VersionArguments {
  game?: Array<string | { rules?: unknown[]; value: string | string[] }>
  jvm?: Array<string | { rules?: unknown[]; value: string | string[] }>
}

export interface VersionAssetIndex {
  id?: string
  url?: string
  sha1?: string
  size?: number
  totalSize?: number
}

export interface VersionLoggingClient {
  argument?: string
  file?: { id: string; sha1?: string; size?: number; url?: string }
  type?: string
}

/** 安装、补全与启动都用到的版本字段（只有 id 是必需的） */
export interface VersionDetail {
  id: string
  mainClass?: string
  inheritsFrom?: string
  type?: string
  arguments?: VersionArguments
  minecraftArguments?: string
  downloads?: {
    client?: VersionArtifact
    server?: VersionArtifact
  }
  libraries?: VersionLibrary[]
  assetIndex?: VersionAssetIndex
  assets?: string
  javaVersion?: { component?: string; majorVersion?: number }
  logging?: { client?: VersionLoggingClient }
  releaseTime?: string
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
  fallbackBase: string,
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
          size: artifact?.size ?? library.size ?? 0,
        },
      },
    })
  }
  return normalized
}

function mergeLibraries(
  parent: VersionLibrary[],
  child: VersionLibrary[],
): VersionLibrary[] {
  const childNames = new Set(child.map((library) => library.name))
  const merged: VersionLibrary[] = []
  const seen = new Set<string>()
  for (const library of parent) {
    if (childNames.has(library.name) || seen.has(library.name)) continue
    seen.add(library.name)
    merged.push(library)
  }
  for (const library of child) {
    if (seen.has(library.name)) continue
    seen.add(library.name)
    merged.push(library)
  }
  return merged
}

function mergeArguments(
  parent: VersionArguments | undefined,
  child: VersionArguments | undefined,
): VersionArguments | undefined {
  if (!parent && !child) return undefined
  return {
    jvm: [...(parent?.jvm ?? []), ...(child?.jvm ?? [])],
    game: [...(parent?.game ?? []), ...(child?.game ?? [])],
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
    downloads: { ...version.downloads, client: { url: client.url } },
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
    releaseTime: child.releaseTime ?? parent.releaseTime,
  }
}
