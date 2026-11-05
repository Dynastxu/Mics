import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 本机 Java 运行时探测。
 *
 * 启动游戏和运行加载器安装器都需要它，因此放在 SDK 主进程入口里共用：
 * 探测规则只依赖操作系统与磁盘布局，与具体插件无关。
 */
export interface JavaRuntime {
  home: string
  java: string
  major: number
}

interface CacheEntry {
  at: number
  runtimes: JavaRuntime[]
}

const CACHE_TTL = 30_000
let cache: CacheEntry | null = null

function javaExecutable(home: string): string | null {
  const name = process.platform === 'win32' ? 'java.exe' : 'java'
  const candidate = path.join(home, 'bin', name)
  return existsSync(candidate) ? candidate : null
}

function parseVersionText(value: string): number | null {
  const text = value.trim()
  const legacy = /^1\.(\d+)/.exec(text)
  if (legacy) return Number(legacy[1])
  const modern = /^(\d+)/.exec(text)
  return modern ? Number(modern[1]) : null
}

function majorOfExecutable(java: string): number | null {
  try {
    const result = spawnSync(java, ['-version'], {
      encoding: 'utf8',
      windowsHide: true
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /version "([^"]+)"/.exec(output)
    return match ? parseVersionText(match[1] ?? '') : null
  } catch {
    return null
  }
}

function majorFromHome(home: string): number | null {
  const release = path.join(home, 'release')
  if (existsSync(release)) {
    try {
      const match = /JAVA_VERSION="([^"]+)"/.exec(readFileSync(release, 'utf8'))
      if (match) {
        const major = parseVersionText(match[1] ?? '')
        if (major) return major
      }
    } catch {
      /* fall through */
    }
  }

  const base = path.basename(home)
  const fromName = /(?:jdk|jre|java)[-_]?(\d+)/i.exec(base)
  if (fromName) {
    const major = Number(fromName[1])
    if (Number.isFinite(major)) return major
  }

  const java = javaExecutable(home)
  return java ? majorOfExecutable(java) : null
}

function addHome(homes: Set<string>, home: string): void {
  if (javaExecutable(home)) homes.add(path.resolve(home))
}

function detectRuntimes(): JavaRuntime[] {
  const homes = new Set<string>()
  const envHome = process.env.JAVA_HOME
  if (envHome) addHome(homes, envHome)

  const roots = new Set<string>()
  if (process.platform === 'win32') {
    const programFiles = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432
    ].filter((value): value is string => Boolean(value))
    for (const base of programFiles) {
      for (const vendor of [
        'Java',
        'Eclipse Adoptium',
        'Microsoft',
        'Zulu',
        'BellSoft',
        'Amazon Corretto'
      ]) {
        roots.add(path.join(base, vendor))
      }
    }
    if (process.env.LOCALAPPDATA) {
      roots.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'))
    }
  } else if (process.platform === 'darwin') {
    roots.add('/Library/Java/JavaVirtualMachines')
  } else {
    roots.add('/usr/lib/jvm')
    roots.add('/usr/java')
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    addHome(homes, root)
    let children: string[]
    try {
      children = readdirSync(root)
    } catch {
      continue
    }
    for (const child of children) {
      const home = path.join(root, child)
      try {
        if (statSync(home).isDirectory()) addHome(homes, home)
      } catch {
        /* ignore */
      }
    }
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const entry of pathEntries) {
    try {
      if (!statSync(entry).isDirectory()) continue
    } catch {
      continue
    }
    const direct = path.join(entry, process.platform === 'win32' ? 'java.exe' : 'java')
    if (existsSync(direct)) {
      const home = path.basename(entry) === 'bin' ? path.dirname(entry) : entry
      homes.add(path.resolve(home))
    }
  }

  const runtimes: JavaRuntime[] = []
  for (const home of homes) {
    const executable = javaExecutable(home)
    if (!executable) continue
    const major = majorFromHome(home)
    if (major) runtimes.push({ home, java: canonicalPath(executable), major })
  }

  return runtimes.sort((a, b) => a.major - b.major)
}

function runtimes(): JavaRuntime[] {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.runtimes
  const found = detectRuntimes()
  cache = { at: Date.now(), runtimes: found }
  return found
}

/**
 * 选择满足版本要求的最低 Java 版本，避免用过高版本启动旧版游戏，
 * 也避免安装器跑在比游戏更高的 Java 上。
 */
function runtimePreference(runtime: JavaRuntime): number {
  const name = path.basename(runtime.home).toLowerCase()
  if (name.startsWith('jdk')) return 0
  if (name.startsWith('jbr')) return 1
  return 2
}

/** 解析符号链接：PATH 里的 java 与 JAVA_HOME 里的同一 JVM 应该归并成一个运行时 */
function canonicalPath(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function runtimeFromHome(home: string): JavaRuntime | null {
  const executable = javaExecutable(home)
  if (!executable) return null
  const major = majorFromHome(home)
  return major ? { home, java: canonicalPath(executable), major } : null
}

const JAVA_NAMES = new Set(['java', 'java.exe', 'javaw', 'javaw.exe'])

function runtimeFromExecutable(file: string): JavaRuntime | null {
  const name = path.basename(file).toLowerCase()
  if (!JAVA_NAMES.has(name)) return null

  const bin = path.dirname(file)
  const home = path.basename(bin).toLowerCase() === 'bin' ? path.dirname(bin) : bin
  // javaw 不输出控制台信息，版本探测改用同目录的 java
  const probe = path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java')
  const major = majorFromHome(home) ?? majorOfExecutable(existsSync(probe) ? probe : file)
  return major ? { home, java: canonicalPath(file), major } : null
}

/** 展开手写路径里的引号、`~` 与环境变量：设置页允许直接粘贴 `%JAVA_HOME%\bin\java.exe` */
function expandUserPath(input: string): string {
  let value = input.trim()
  const head = value.charAt(0)
  if (value.length >= 2 && (head === '"' || head === "'") && value.endsWith(head)) {
    value = value.slice(1, -1).trim()
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1))
  }
  return value
    .replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$\{([^}]+)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => process.env[name] ?? match)
    .trim()
}

/**
 * 把用户填写的 Java 位置解析成本机运行时。
 *
 * 接受 `java` / `java.exe` 可执行文件、Java 主目录，或主目录下的 `bin`；
 * 文本可以带引号、`~` 与环境变量。解析不到时返回 null，由调用方决定怎么提示。
 */
export function resolveJavaPath(input: string): JavaRuntime | null {
  const value = expandUserPath(input)
  if (!value) return null
  const target = path.resolve(value)

  let directory: boolean
  try {
    directory = statSync(target).isDirectory()
  } catch {
    return null
  }

  if (directory) {
    return (
      runtimeFromHome(target) ??
      (path.basename(target).toLowerCase() === 'bin' ? runtimeFromHome(path.dirname(target)) : null)
    )
  }
  return runtimeFromExecutable(target)
}

/**
 * 本机检测到的全部 Java 运行时（按主版本升序）。
 *
 * `refresh` 会跳过 30 秒缓存：设置页的「自动检测」按钮要能看到刚装好的 Java。
 */
export function detectJavaRuntimes(refresh = false): JavaRuntime[] {
  if (refresh) cache = null
  return runtimes().map((runtime) => ({ ...runtime }))
}

export function findJava(requiredMajor: number): JavaRuntime {
  const found = runtimes()
  const suitable = found
    .filter((runtime) => runtime.major >= requiredMajor)
    .sort((a, b) => a.major - b.major || runtimePreference(a) - runtimePreference(b))
  if (suitable.length > 0) return suitable[0]!

  const detected =
    found.length > 0 ? found.map((runtime) => `Java ${runtime.major}`).join('、') : '未检测到 Java'
  throw new Error(`需要 Java ${requiredMajor} 或更高版本（检测到：${detected}）`)
}
