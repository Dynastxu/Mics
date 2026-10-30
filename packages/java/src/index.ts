import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

function majorFromHome(home: string): number | null {
  const release = path.join(home, 'release')
  if (existsSync(release)) {
    try {
      const match = /JAVA_VERSION="([^"]+)"/.exec(readFileSync(release, 'utf8'))
      if (match) {
        const major = parseVersionText(match[1] ?? '')
        if (major) return major
      }
    } catch { /* fall through */ }
  }

  const base = path.basename(home)
  const fromName = /(?:jdk|jre|java)[-_]?(\d+)/i.exec(base)
  if (fromName) {
    const major = Number(fromName[1])
    if (Number.isFinite(major)) return major
  }

  const java = javaExecutable(home)
  if (!java) return null
  try {
    const result = spawnSync(java, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /version "([^"]+)"/.exec(output)
    return match ? parseVersionText(match[1] ?? '') : null
  } catch {
    return null
  }
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
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
      .filter((value): value is string => Boolean(value))
    for (const base of programFiles) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto']) {
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
      } catch { /* ignore */ }
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
    const java = javaExecutable(home)
    if (!java) continue
    const major = majorFromHome(home)
    if (major) runtimes.push({ home, java, major })
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

export function findJava(requiredMajor: number): JavaRuntime {
  const found = runtimes()
  const suitable = found
    .filter((runtime) => runtime.major >= requiredMajor)
    .sort((a, b) => a.major - b.major || runtimePreference(a) - runtimePreference(b))
  if (suitable.length > 0) return suitable[0]!

  const detected = found.length > 0
    ? found.map((runtime) => `Java ${runtime.major}`).join('、')
    : '未检测到 Java'
  throw new Error(`需要 Java ${requiredMajor} 或更高版本（检测到：${detected}）`)
}
