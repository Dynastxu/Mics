import { createHash } from 'node:crypto'
import { copyFile, link, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LoaderSourceKind } from '@mics/sdk'
import { mavenPath } from '../version'
import { readZipTextEntry } from './jar'
import { absoluteUrl, OFFICIAL_LOADER_BASES } from './sources'

/**
 * 安装器的依赖库预取。
 *
 * Forge / NeoForge 的 installer.jar 会在自己的进程里逐一下载依赖（先按
 * `version.json` 的运行库，再按 `install_profile.json` 的处理器依赖），地址直指
 * 官方 maven；国内常见只有几 KB/s，于是「安装加载器」这一步能拖上几分钟甚至更久。
 *
 * 这里做 PCL 的同类处理：安装器启动前先按它声明的两份清单把库取好，放进它自己的
 * `libraries/`。安装器发现文件已存在且摘要一致就直接跳过下载，只跑处理器。
 * 下载复用下载管线的多源能力（镜像 + 竞速），并且优先用共享库目录里已有的文件
 * 做硬链接，避免重复下载。
 *
 * 解析失败（未知安装器格式）时静默返回：安装器自己下载也能装完，只是慢。
 */

interface InstallerLibrary {
  name: string
  /** maven 相对路径 */
  path: string
  url: string
  sha1: string
  size: number
}

export interface InstallerPrefetchOptions {
  /** 安装器的 libraries 目录（`<installClient>/libraries`） */
  librariesDir: string
  /** 共享库目录；已有同内容文件时直接硬链接，不再下载 */
  sharedLibrariesDir: string
  download: (url: string, target: string, sha1?: string, size?: number) => Promise<void>
  report?: (note: string, percent?: number) => void
  log: (level: 'info' | 'warn', message: string) => void
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把 install_profile.json / version.json 的 libraries 展开成可下载的条目 */
function parseLibraries(text: string | null, kind: LoaderSourceKind): InstallerLibrary[] {
  if (!text) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const record = recordOf(parsed)
  // 1.13+：install_profile 顶层 libraries 是安装器/处理器依赖；
  // 更老的安装器把版本信息塞在 install_profile.versionInfo 里。
  const lists = [
    record?.libraries,
    recordOf(record?.versionInfo)?.libraries,
  ].filter(Array.isArray) as unknown[][]

  const base = OFFICIAL_LOADER_BASES[kind].maven
  const libraries: InstallerLibrary[] = []

  for (const list of lists) {
    for (const value of list) {
      const entry = recordOf(value)
      const name = stringOf(entry?.name)
      if (!name) continue
      // 只给服务端用的库不必取
      if (entry?.clientreq === false) continue

      const artifact = recordOf(recordOf(entry?.downloads)?.artifact)
      const relative = stringOf(artifact?.path) || mavenPath(name)
      if (!relative) continue

      const url = stringOf(artifact?.url) || absoluteUrl(base, relative)
      if (!url) continue

      libraries.push({
        name,
        path: relative,
        url,
        sha1: stringOf(artifact?.sha1),
        size: numberOf(artifact?.size),
      })
    }
  }

  return libraries
}

/** 合并多份清单：同一路径只留一份，优先保留带摘要的条目 */
function mergeLibraries(lists: InstallerLibrary[][]): InstallerLibrary[] {
  const byPath = new Map<string, InstallerLibrary>()
  for (const list of lists) {
    for (const library of list) {
      const existing = byPath.get(library.path)
      if (!existing) {
        byPath.set(library.path, library)
        continue
      }
      if (!existing.sha1 && library.sha1) byPath.set(library.path, library)
    }
  }
  return [...byPath.values()]
}

async function sha1Of(file: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(file)).digest('hex')
  } catch {
    return null
  }
}

/** 共享库目录里已有同内容文件时，硬链接到安装器目录，省掉一次下载 */
async function reuseFromShared(spec: InstallerLibrary, target: string, sharedRoot: string): Promise<boolean> {
  const source = path.join(sharedRoot, spec.path)
  try {
    const info = await stat(source)
    if (!info.isFile()) return false
    if (spec.size > 0 && info.size !== spec.size) return false
    if (spec.sha1 && await sha1Of(source) !== spec.sha1) return false
  } catch {
    return false
  }

  try {
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await link(source, target)
    } catch {
      // 跨卷或文件系统不支持硬链接
      await copyFile(source, target)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 固定并发跑完一组任务。
 *
 * 任何一个失败就停止派发新任务，但**等在途任务结束**再抛出：安装器马上要跑，
 * 不能让后台下载继续往它的 libraries 目录里写。
 */
async function eachLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  let failure: unknown = null

  const run = async (): Promise<void> => {
    while (failure === null) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      try {
        await worker(item)
      } catch (cause) {
        failure ??= cause
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  if (failure !== null) throw failure
}

export async function prefetchInstallerLibraries(
  installerPath: string,
  kind: LoaderSourceKind,
  options: InstallerPrefetchOptions,
): Promise<void> {
  const libraries = mergeLibraries([
    parseLibraries(readZipTextEntry(installerPath, 'install_profile.json'), kind),
    // 安装器自己也会逐个下载 version.json 里的运行库（日志里的 "Considering library"）
    parseLibraries(readZipTextEntry(installerPath, 'version.json'), kind),
  ])
  if (libraries.length === 0) return

  let done = 0
  const total = libraries.length
  const tick = (): void => {
    done += 1
    options.report?.(`下载加载器依赖库 ${done}/${total}`, (done / total) * 100)
  }

  options.report?.(`下载加载器依赖库 0/${total}`, 0)
  await eachLimit(libraries, 6, async (library) => {
    const target = path.join(options.librariesDir, library.path)
    if (await reuseFromShared(library, target, options.sharedLibrariesDir)) {
      tick()
      return
    }
    await options.download(library.url, target, library.sha1, library.size)
    tick()
  })

  options.log('info', `安装器依赖库已就绪：${total} 个`)
}
