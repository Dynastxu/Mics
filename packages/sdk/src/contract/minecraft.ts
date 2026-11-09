/**
 * Minecraft 版本档案（version json）的共享类型。
 *
 * 原版安装、加载器安装、整合包与补全都围绕同一份数据工作：
 * - 原版版本档案由 Mojang 提供；
 * - 加载器版本档案只声明差异，通过 `inheritsFrom` 指向原版；
 * - 安装时会把两者合并成自包含的版本档案，启动与补全不再解析继承关系。
 *
 * 这些类型只描述磁盘上的数据结构，不包含任何下载/安装逻辑；合并、规则判断等
 * 纯函数在 `@mics/sdk/main` 的 `node/minecraft.ts`。
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

/** 版本文件里的系统规则 */
export interface VersionRule {
  action?: string
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}
