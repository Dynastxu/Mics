import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LaunchCredentials, ShellExecuteCapability, ShellProcess } from '@mics/sdk'
import { findJava } from '@mics/java'
import type { ResolvedInstance } from './instances'
import type { MissingFile } from './shared'
import type { ArgumentEntry, Library, LibraryDownload, Rule } from './version'
import { isReadableJar, syncNativeLibraries } from './zip'

export interface LaunchOptions {
  /** 由账户插件解析出的启动凭据（名字、UUID、令牌、user_type、额外 JVM 参数） */
  credentials: LaunchCredentials
  launcherVersion: string
  memoryMb?: number
  /** 启动准备阶段的告警出口；由调用方接到插件日志器上 */
  onLog?: (level: 'info' | 'warn', message: string) => void
}

export interface LaunchPlan {
  java: string
  args: string[]
  cwd: string
  logPath: string
  javaMajor: number
}

/** 已 spawn 的游戏进程；child 用于订阅退出事件与判断存活 */
export interface LaunchedProcess {
  pid: number
  child: ShellProcess
}

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
const OS_KEY = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
const ARCH_NAME = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86'

const FEATURES: Record<string, boolean> = {
  is_demo_user: false,
  has_custom_resolution: true,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
}

function ruleMatches(rule: Rule): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false
    if (rule.os.arch && rule.os.arch !== ARCH_NAME) return false
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false
      } catch {
        return false
      }
    }
  }
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (FEATURES[key] !== expected) return false
    }
  }
  return true
}

function rulesAllow(rules: Rule[] | undefined): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!ruleMatches(rule)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

function replaceVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => variables[key] ?? '')
}

function expandArguments(
  entries: Array<string | ArgumentEntry>,
  variables: Record<string, string>,
): string[] {
  const result: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      result.push(replaceVariables(entry, variables))
      continue
    }
    if (!rulesAllow(entry.rules)) continue
    const values = Array.isArray(entry.value) ? entry.value : [entry.value]
    result.push(...values.map((value) => replaceVariables(value, variables)))
  }
  return result
}

function mavenPath(name: string): string {
  const [group, artifact, version, classifier] = name.split(':')
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return `${group?.replace(/\./g, '/') ?? ''}/${artifact}/${version}/${fileName}`
}

function locateFile(file: string): string | null {
  const candidates = [file, `${file}.jar`]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  const directory = path.dirname(file)
  const base = path.basename(file)
  if (!existsSync(directory)) return null
  try {
    for (const entry of readdirSync(directory)) {
      if (entry === base || entry.startsWith(`${base}.`)) return path.join(directory, entry)
    }
  } catch { /* ignore */ }
  return null
}

function fileSha1(file: string): string | null {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** JAR 必须是结构完整的 ZIP；用来识别镜像错误页与断点续传追加造成的损坏 */
function needsStructuralCheck(file: string, expectedSha1: string | undefined): boolean {
  return !expectedSha1 && file.toLowerCase().endsWith('.jar')
}

/** 文件是否可以直接用于启动：有摘要按摘要，没有摘要的 jar 至少要是可读的 ZIP */
function fileIsUsable(file: string, expectedSha1: string | undefined): boolean {
  const current = fileSha1(file)
  if (!current) return false
  if (expectedSha1) return current === expectedSha1
  return !needsStructuralCheck(file, expectedSha1) || isReadableJar(file)
}

/**
 * 启动准备阶段发现必要文件缺失。
 *
 * 这是一个「可预期的结果」，不是异常路径：调用方据此弹窗询问用户是否补全，
 * 下载交给 `mics.download.manager` 的补全流程（多源、校验、缓存都在那边）。
 */
export class InstanceFilesMissingError extends Error {
  readonly files: MissingFile[]

  constructor(files: MissingFile[]) {
    super(`缺少 ${files.length} 个必要文件，需要先补全`)
    this.name = 'InstanceFilesMissingError'
    this.files = files
  }
}

interface LaunchFile {
  label: string
  file: string
  sha1?: string
}

function relativeTo(root: string, file: string): string {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file
}

/** 逐个检查启动需要的文件，返回缺失 / 损坏的清单 */
function missingFilesOf(root: string, files: LaunchFile[]): MissingFile[] {
  const missing: MissingFile[] = []
  for (const entry of files) {
    if (fileIsUsable(entry.file, entry.sha1)) continue
    missing.push({ label: entry.label, path: relativeTo(root, entry.file) })
  }
  return missing
}

function nativeClassifier(): string {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'natives-windows-arm64' : 'natives-windows'
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'natives-macos-arm64' : 'natives-macos'
  }
  return process.arch === 'arm64' ? 'natives-linux-arm64' : 'natives-linux'
}

function isNativeClassifier(library: Library): boolean {
  return library.name.includes(':natives-')
}

interface NativeEntry {
  relative: string
  artifact?: LibraryDownload
}

function nativeEntry(library: Library): NativeEntry | null {
  const classifier = nativeClassifier()
  if (library.name.endsWith(`:${classifier}`)) {
    return {
      relative: library.downloads?.artifact?.path ?? mavenPath(library.name),
      artifact: library.downloads?.artifact,
    }
  }

  if (!library.natives) return null
  const raw = library.natives[OS_KEY]
  if (!raw) return null
  const arch = process.arch === 'x64' ? '64' : '32'
  const nativeName = raw.replace('${arch}', arch)
  const artifact = library.downloads?.classifiers?.[nativeName]
  if (!artifact) return null
  return {
    relative: artifact.path ?? `${path.dirname(mavenPath(library.name))}/${path.basename(mavenPath(library.name), '.jar')}-${nativeName}.jar`,
    artifact,
  }
}

/** 启动时需要的 native jar 清单（只包含当前平台实际会加载的库） */
function nativeJarFiles(libraries: Library[], librariesDir: string): LaunchFile[] {
  const files: LaunchFile[] = []
  for (const library of libraries) {
    if (!rulesAllow(library.rules)) continue
    const native = nativeEntry(library)
    if (!native) continue
    const target = path.join(librariesDir, native.relative)
    files.push({
      label: library.name,
      file: locateFile(target) ?? target,
      sha1: native.artifact?.sha1,
    })
  }
  return files
}

/** 旧版实现为每次启动创建 run-* 目录；空闲超过这么久才回收 */
const LEGACY_NATIVES_AGE = 10 * 60 * 1000

/**
 * 清理 natives 目录里不再需要的文件。
 *
 * - 只删文件；目录（旧版留下的 java/jna/lwjgl/netty、run-*）单独处理；
 * - 旧版 run-* 目录超过 10 分钟才删，避免误伤正在启动的实例；
 * - 删除被占用时直接放弃本轮清理，绝不阻塞启动。
 */
function pruneNatives(root: string, expected: Set<string>): void {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const wanted = new Set([...expected].map(normalize))
  const now = Date.now()

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('run-')) continue
        try {
          if (now - statSync(target).mtimeMs < LEGACY_NATIVES_AGE) continue
          rmSync(target, { recursive: true, force: true })
        } catch { /* 仍被运行中的实例占用 */ }
        continue
      }
      if (wanted.has(normalize(target))) continue
      try {
        rmSync(target, { force: true })
      } catch {
        return
      }
    }
  } catch { /* 还没有 natives 目录 */ }
}

/**
 * 同步 native 目录。
 *
 * 实例目录就是版本目录，同一版本的多次启动共用一个 `natives` 目录，不会因为
 * 「仍要启动」而清空重建：文件大小一致就复用；需要更新但被运行中的实例锁住时
 * 跳过，沿用现有 DLL。
 *
 * 调用前 `nativeJarFiles` 已经确认过所有 jar 完整，这里不再做下载。
 */
function syncNatives(
  instance: ResolvedInstance,
  files: LaunchFile[],
  onLog?: LaunchOptions['onLog'],
): { dir: string; jars: string[] } {
  const nativesDir = instance.layout.nativesDir
  mkdirSync(nativesDir, { recursive: true })

  const expected = new Set<string>()
  const jars: string[] = []
  let complete = true

  for (const entry of files) {
    try {
      const synced = syncNativeLibraries(entry.file, nativesDir)
      for (const file of synced.files) expected.add(file)
      if (synced.locked) {
        onLog?.('warn', `natives 正被运行中的实例占用，跳过更新：${entry.label}`)
      }
      jars.push(entry.file)
    } catch (cause) {
      // 单个本地库损坏不应阻止启动；游戏可能只是缺少可选加速库。
      complete = false
      onLog?.('warn', `本地库处理失败：${entry.label}（${(cause as Error).message}）`)
    }
  }

  // 有 jar 读取失败时不做清理，避免把它的文件当成多余文件删掉。
  if (complete && expected.size > 0) pruneNatives(nativesDir, expected)
  return { dir: nativesDir, jars }
}

export async function buildLaunchPlan(instance: ResolvedInstance, options: LaunchOptions): Promise<LaunchPlan> {
  const version = instance.version
  const requiredJava = version.javaVersion?.majorVersion ?? 8
  const java = findJava(requiredJava)

  // 资源在共享目录（跨实例一份），实例目录里只放这个版本自己的文件
  const assetsDir = instance.layout.assetsDir
  const librariesDir = instance.layout.librariesDir
  const libraries = version.libraries ?? []

  // 1. 先收集启动需要的全部文件，只校验、不下载：下载属于下载管线的职责。
  const expectedFiles: LaunchFile[] = []

  const client = version.downloads?.client
  const direct = path.join(instance.dir, `${version.id}.jar`)
  const alternative = path.join(instance.dir, 'client.jar')
  const clientJar = locateFile(direct) ?? locateFile(alternative) ?? direct
  expectedFiles.push({ label: 'client.jar', file: clientJar, sha1: client?.sha1 })

  const assetIndex = version.assetIndex?.id ?? version.assets ?? 'legacy'
  if (assetIndex !== 'legacy') {
    expectedFiles.push({
      label: `资源索引 ${assetIndex}`,
      file: path.join(assetsDir, 'indexes', `${assetIndex}.json`),
      sha1: version.assetIndex?.sha1,
    })
  }

  const natives = nativeJarFiles(libraries, librariesDir)
  expectedFiles.push(...natives)

  const librariesInClasspath: string[] = []
  for (const library of libraries) {
    if (!rulesAllow(library.rules)) continue
    if (isNativeClassifier(library)) continue
    const artifact = library.downloads?.artifact
    const relative = artifact?.path ?? mavenPath(library.name)
    const target = path.join(librariesDir, relative)
    const file = locateFile(target) ?? target
    // 老的合并版本文件把加载器库的 sha1 留在条目顶层，也要用来校验
    expectedFiles.push({ label: library.name, file, sha1: artifact?.sha1 || library.sha1 })
    librariesInClasspath.push(file)
  }

  const missing = missingFilesOf(instance.dir, expectedFiles)
  if (missing.length > 0) throw new InstanceFilesMissingError(missing)

  // 2. 文件齐全后才解压 native，避免把半损坏的 jar 解出一套残缺的 DLL。
  const nativesDir = syncNatives(instance, natives, options.onLog)

  const classpath = [clientJar, ...librariesInClasspath, ...nativesDir.jars]

  const memoryMb = Math.max(1024, Math.min(32768, Math.round(options.memoryMb ?? 4096)))
  const credentials = options.credentials
  const variables: Record<string, string> = {
    auth_player_name: credentials.name,
    version_name: version.id,
    game_directory: instance.dir,
    assets_root: assetsDir,
    assets_index_name: assetIndex,
    auth_uuid: credentials.uuid,
    auth_access_token: credentials.accessToken,
    auth_session: credentials.accessToken,
    user_type: credentials.userType,
    version_type: version.type ?? 'release',
    game_assets: assetsDir,
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    natives_directory: nativesDir.dir,
    launcher_name: 'Mics',
    launcher_version: options.launcherVersion,
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: librariesDir,
    resolution_width: '1280',
    resolution_height: '720',
    path: '',
  }

  const jvmArgs: string[] = [`-Xms${Math.min(1024, memoryMb)}M`, `-Xmx${memoryMb}M`]
  // 账户插件提供的额外参数（例如第三方登录要注入的 javaagent）原样拼在前面，
  // 启动管线不判断账户类型，也不假设一定有。
  jvmArgs.push(...(credentials.jvmArgs ?? []))
  if (version.arguments?.jvm) {
    jvmArgs.push(...expandArguments(version.arguments.jvm, variables))
  }

  const logFile = version.logging?.client?.file
  if (logFile) {
    const configPath = path.join(instance.layout.logConfigsDir, logFile.id)
    // 日志配置缺失不影响启动：跳过即可，不为了一个可选项中断整个流程
    if (fileIsUsable(configPath, logFile.sha1)) {
      variables.path = configPath
      const argument = version.logging?.client?.argument ?? '-Dlog4j.configurationFile=${path}'
      jvmArgs.push(replaceVariables(argument, variables))
    } else {
      options.onLog?.('warn', `日志配置缺失或损坏，已跳过：${logFile.id}`)
    }
  }

  const classpathFlag = jvmArgs.includes('-cp') || jvmArgs.includes('-classpath')
  if (!classpathFlag) jvmArgs.push('-cp', variables.classpath!)
  // 26.x 的版本把 java.library.path 指向子目录；追加一项覆盖成本地库根目录。
  jvmArgs.push(`-Djava.library.path=${nativesDir.dir}`)

  let gameArgs: string[]
  if (version.arguments?.game && version.arguments.game.length > 0) {
    gameArgs = expandArguments(version.arguments.game, variables)
  } else if (version.minecraftArguments) {
    gameArgs = version.minecraftArguments
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => replaceVariables(value, variables))
  } else {
    gameArgs = []
  }

  mkdirSync(path.join(instance.dir, 'logs'), { recursive: true })
  mkdirSync(path.join(instance.dir, 'mods'), { recursive: true })

  return {
    java: java.java,
    args: [...jvmArgs, version.mainClass, ...gameArgs],
    cwd: instance.dir,
    logPath: path.join(instance.dir, 'logs', 'mics-launch.log'),
    javaMajor: java.major,
  }
}

function quoteForLog(value: string): string {
  return /[\s"]/g.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

export async function launchInstance(
  shell: ShellExecuteCapability,
  instance: ResolvedInstance,
  options: LaunchOptions,
): Promise<LaunchedProcess> {
  const plan = await buildLaunchPlan(instance, options)
  const line = `[${new Date().toISOString()}] ${quoteForLog(plan.java)} ${plan.args.map(quoteForLog).join(' ')}\n`
  appendFileSync(plan.logPath, line, 'utf8')

  // 启动进程走 shell.execute 能力：本机实现只是其中一种 provider，
  // 换成沙箱实现时这里不需要改（日志文件与 detached 由 provider 落地）。
  const child = await shell.spawn({
    command: plan.java,
    args: plan.args,
    cwd: plan.cwd,
    logFile: plan.logPath,
    detached: true,
  })

  if (!child.pid) {
    child.kill()
    throw new Error('未能创建游戏进程')
  }
  // 进程独立运行：应用退出不影响游戏；child 仍可用来订阅退出事件。
  child.detach()
  return { pid: child.pid, child }
}
