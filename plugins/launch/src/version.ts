/** Mojang version JSON 中启动所需的字段（只声明实际用到的部分） */

export interface OsRule {
  name?: string
  arch?: string
  version?: string
}

export interface Rule {
  action: 'allow' | 'deny'
  os?: OsRule
  features?: Record<string, boolean>
}

export interface LibraryDownload {
  path?: string
  sha1?: string
  size?: number
  url?: string
}

export interface Library {
  name: string
  downloads?: {
    artifact?: LibraryDownload
    classifiers?: Record<string, LibraryDownload>
  }
  natives?: Record<string, string>
  rules?: Rule[]
  extract?: { exclude?: string[] }
}

export interface ArgumentEntry {
  rules?: Rule[]
  value: string | string[]
}

export interface VersionAssetIndex {
  id: string
  sha1?: string
  size?: number
  totalSize?: number
  url?: string
}

export interface VersionLoggingFile {
  id: string
  sha1?: string
  size?: number
  url?: string
}

export interface VersionJson {
  id: string
  type?: string
  mainClass: string
  inheritsFrom?: string
  assets?: string
  assetIndex?: VersionAssetIndex
  downloads?: {
    client?: LibraryDownload
    server?: LibraryDownload
  }
  libraries?: Library[]
  arguments?: {
    game?: Array<string | ArgumentEntry>
    jvm?: Array<string | ArgumentEntry>
  }
  minecraftArguments?: string
  javaVersion?: {
    component?: string
    majorVersion?: number
  }
  logging?: {
    client?: {
      argument?: string
      file?: VersionLoggingFile
      type?: string
    }
  }
  releaseTime?: string
}
