import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { findJava } from './java'
import type { ResolvedInstance } from './instances'
import type { ArgumentEntry, Library, LibraryDownload, Rule } from './version'
import { syncNativeLibraries } from './zip'

export interface LaunchOptions {
  username: string
  launcherVersion: string
  memoryMb?: number
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
  child: ChildProcess
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

function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('重定向次数过多'))
      return
    }

    const secure = url.startsWith('https')
    const proto = secure ? https : http
    const request = proto.get(url, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        let next: string
        try {
          next = new URL(response.headers.location, url).toString()
        } catch {
          reject(new Error('无效的重定向地址'))
          return
        }
        downloadFile(next, destination, redirects + 1).then(resolve, reject)
        return
      }
      if (status >= 400 || status === 0) {
        response.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }

      mkdirSync(path.dirname(destination), { recursive: true })
      const temporary = `${destination}.download`
      const output = createWriteStream(temporary)
      pipeline(response, output)
        .then(() => {
          renameSync(temporary, destination)
          resolve()
        })
        .catch((cause: unknown) => {
          rmSync(temporary, { force: true })
          reject(cause)
        })
    })

    request.setTimeout(60_000, () => request.destroy(new Error('下载超时')))
    request.on('error', reject)
  })
}

async function ensureFile(
  file: string,
  expectedSha1: string | undefined,
  url: string | undefined,
  label: string,
): Promise<string> {
  const current = fileSha1(file)
  if (current && (!expectedSha1 || current === expectedSha1)) return file

  if (!url) {
    throw new Error(`文件缺失或损坏，且没有可用的下载地址：${label}`)
  }

  console.warn(`[mics.launch] 修复 ${label}`)
  await downloadFile(url, file)
  const repaired = fileSha1(file)
  if (expectedSha1 && repaired !== expectedSha1) {
    rmSync(file, { force: true })
    throw new Error(`文件校验失败：${label}`)
  }
  return file
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

function offlineUuid(username: string): string {
  const digest = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x30
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function resolveClientJar(instance: ResolvedInstance): Promise<string> {
  const client = instance.version.downloads?.client
  const direct = path.join(instance.versionDir, `${instance.version.id}.jar`)
  const alternative = path.join(instance.versionDir, 'client.jar')
  const located = locateFile(direct) ?? locateFile(alternative) ?? direct
  return ensureFile(located, client?.sha1, client?.url, 'client.jar')
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
 * 同一版本的所有启动共用一个 `natives` 目录，不会因为「仍要启动」而清空重建：
 * 文件大小一致就复用；需要更新但被运行中的实例锁住时跳过，沿用现有 DLL。
 */
async function prepareNatives(
  instance: ResolvedInstance,
  libraries: Library[],
  librariesDir: string,
): Promise<{ dir: string; jars: string[] }> {
  const nativesDir = path.join(instance.versionDir, 'natives')
  mkdirSync(nativesDir, { recursive: true })

  const expected = new Set<string>()
  const jars: string[] = []
  let complete = true

  for (const library of libraries) {
    if (!rulesAllow(library.rules)) continue
    const native = nativeEntry(library)
    if (!native) continue
    const target = path.join(librariesDir, native.relative)
    const file = locateFile(target) ?? target
    try {
      await ensureFile(file, native.artifact?.sha1, native.artifact?.url, library.name)
      const synced = syncNativeLibraries(file, nativesDir)
      for (const entry of synced.files) expected.add(entry)
      if (synced.locked) {
        console.warn(`[mics.launch] natives 正被运行中的实例占用，跳过更新：${native.relative}`)
      }
      jars.push(file)
    } catch (cause) {
      // 单个本地库损坏不应阻止启动；游戏可能只是缺少可选加速库。
      complete = false
      console.warn(`[mics.launch] 本地库处理失败：${native.relative}（${(cause as Error).message}）`)
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

  const assetsDir = path.join(instance.versionDir, 'assets')
  const librariesDir = path.join(instance.versionDir, 'libraries')
  const clientJar = await resolveClientJar(instance)
  const libraries = version.libraries ?? []

  const assetIndex = version.assetIndex?.id ?? version.assets ?? 'legacy'
  if (assetIndex !== 'legacy') {
    const indexPath = path.join(assetsDir, 'indexes', `${assetIndex}.json`)
    await ensureFile(
      indexPath,
      version.assetIndex?.sha1,
      version.assetIndex?.url,
      `资源索引 ${assetIndex}`,
    )
  }

  const natives = await prepareNatives(instance, libraries, librariesDir)

  const classpath = [clientJar]
  for (const library of libraries) {
    if (!rulesAllow(library.rules)) continue
    if (isNativeClassifier(library)) continue
    const artifact = library.downloads?.artifact
    const relative = artifact?.path ?? mavenPath(library.name)
    const target = path.join(librariesDir, relative)
    const file = locateFile(target) ?? target
    await ensureFile(file, artifact?.sha1, artifact?.url, library.name)
    classpath.push(file)
  }
  classpath.push(...natives.jars)

  const memoryMb = Math.max(1024, Math.min(32768, Math.round(options.memoryMb ?? 4096)))
  const variables: Record<string, string> = {
    auth_player_name: options.username,
    version_name: version.id,
    game_directory: instance.dir,
    assets_root: assetsDir,
    assets_index_name: assetIndex,
    auth_uuid: offlineUuid(options.username),
    auth_access_token: '0',
    auth_session: '0',
    user_type: 'legacy',
    version_type: version.type ?? 'release',
    game_assets: assetsDir,
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    natives_directory: natives.dir,
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
  if (version.arguments?.jvm) {
    jvmArgs.push(...expandArguments(version.arguments.jvm, variables))
  }

  const logFile = version.logging?.client?.file
  if (logFile) {
    const configPath = path.join(instance.versionDir, 'log_configs', logFile.id)
    try {
      await ensureFile(configPath, logFile.sha1, logFile.url, `日志配置 ${logFile.id}`)
      variables.path = configPath
      const argument = version.logging?.client?.argument ?? '-Dlog4j.configurationFile=${path}'
      jvmArgs.push(replaceVariables(argument, variables))
    } catch (cause) {
      console.warn(`[mics.launch] 日志配置不可用：${(cause as Error).message}`)
    }
  }

  const classpathFlag = jvmArgs.includes('-cp') || jvmArgs.includes('-classpath')
  if (!classpathFlag) jvmArgs.push('-cp', variables.classpath!)
  // 26.x 的版本把 java.library.path 指向子目录；追加一项覆盖成本地库根目录。
  jvmArgs.push(`-Djava.library.path=${natives.dir}`)

  let gameArgs: string[]
  if (version.arguments?.game) {
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

export async function launchInstance(instance: ResolvedInstance, options: LaunchOptions): Promise<LaunchedProcess> {
  const plan = await buildLaunchPlan(instance, options)
  const line = `[${new Date().toISOString()}] ${quoteForLog(plan.java)} ${plan.args.map(quoteForLog).join(' ')}\n`
  appendFileSync(plan.logPath, line, 'utf8')

  const logFd = openSync(plan.logPath, 'a')
  try {
    const child = spawn(plan.java, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (!child.pid) {
      child.kill()
      throw new Error('未能创建游戏进程')
    }
    // 进程独立运行：应用退出不影响游戏；child 仍可用来订阅退出事件。
    child.unref()
    return { pid: child.pid, child }
  } finally {
    closeSync(logFd)
  }
}
