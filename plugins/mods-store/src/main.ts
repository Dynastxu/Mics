import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type { DownloadFileRequest, DownloadPlacement, DownloadPlacementResult } from '@mics/sdk'
import { defineMainPlugin, instancesRoot } from '@mics/sdk/main'

/**
 * Mod 内容库。
 *
 * 实例里的 `mods/*.jar` 不再各自保存一份实体：下载管线在校验通过后派发
 * `download/commit`，这个插件把实体搬进 `<userData>/mods/<sha1>.jar`，再在
 * 实例原位置创建一条硬链接。同一个文件装进十个实例只占一份磁盘，卸载实例
 * 也不会动到别处仍在用的内容。
 *
 * 三条边界：
 *
 * - **只在硬链接可用的卷上这么做**：启动时探测一次，失败（FAT32、网络盘、
 *   权限不足）就整体退回普通文件；运行期任何一次链接失败也会永久退回。
 * - **同名不同内容不覆盖**：`download/targets` 在任务登记之前改目标，已有
 *   不同摘要的同名文件时，新文件改名为 `名字 (摘要前 8 位).jar`。
 * - **删除只删链接**：`mods/removed` 通知后扫描库存，只剩一条目录项（没有
 *   任何实例链接引用）的实体才回收，避免误删仍被别的实例使用的文件。
 *
 * 启用 / 禁用 Mod 仍然只是重命名（`foo.jar` ↔ `foo.jar.disabled`）：硬链接
 * 是独立的目录项，重命名只动实例里的那条链接，库存实体与其它的链接都不受影响，
 * 因此不需要为开关单独加拦截。
 */

/** 库存实体名：`<sha1>.jar`。回收只认这个形状，不碰用户自己放进目录的文件 */
const STORED_NAME = /^[0-9a-f]{40}\.jar$/
const MOD_FILE = /\.jar$/i
/** 库存目录默认名（相对用户数据目录） */
const DEFAULT_DIRECTORY = 'mods'
/** 同名冲突时最多尝试的后缀数；到上限就放弃改名，交给默认流程 */
const MAX_SUFFIX = 128

export const name = 'mics.mods.store'
export const inject = ['host', 'storage']

export function apply(ctx: Context): void {
  const log = ctx.logger(name)
  const userData = ctx.host.paths.userData
  const storeDir = resolveStoreDir(
    userData,
    String(ctx.storage.get<string>('directory', DEFAULT_DIRECTORY) ?? '')
  )
  const instancesDir = path.resolve(instancesRoot(userData))
  const enabled = (): boolean => ctx.storage.get<boolean>('enabled', true) !== false

  /** 目标是否是实例 mods 目录下的 jar；资源包、数据包与整合包覆盖文件不参与 */
  const isInstanceMod = (file: string): boolean => {
    const relative = path.relative(instancesDir, path.resolve(file))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
    const parts = relative.split(path.sep)
    return parts.length === 3 && parts[1] === 'mods' && MOD_FILE.test(parts[2] ?? '')
  }

  /** 硬链接在这个卷上是否可用；探测失败时整体退回普通文件 */
  let hardlink = true
  const linkReady = probeHardlink(storeDir).catch(() => false)
  void linkReady.then((ok) => {
    hardlink = ok
    if (ok) void sweep()
    else log.info('当前卷不支持硬链接，Mod 将以普通文件保存')
  })

  /** 正在写入的实体名：回收扫描不能把「已搬到库里、还没建链接」的文件当成孤儿 */
  const pending = new Set<string>()
  let sweeping: Promise<void> | null = null

  /**
   * 给同名但内容不同的文件让路。
   *
   * 旧的下载管线直接在目标上 rename，同名不同版本的 Mod 会被静默覆盖。
   * 改名只发生在任务登记之前，此时还没有任何字节落盘，因此不需要回滚。
   */
  ctx.on('download/targets', async (targets, next) => {
    const resolved = await next()
    if (!enabled() || !(await linkReady) || !hardlink) return resolved

    const claimed = new Set<string>()
    const output: DownloadFileRequest[] = []
    for (const target of resolved) {
      output.push(
        target.sha1 && isInstanceMod(target.savePath)
          ? await avoidCollision(target, claimed)
          : target
      )
    }
    return output
  })

  /**
   * 把实体搬进内容库，只在实例里留一条硬链接。
   *
   * 失败时不冒险：能恢复就恢复成普通文件并返回 `next()`，让管线按原样继续；
   * 恢复也失败才抛错，宁可让任务失败，也不能留下一个「已完成但文件不存在」的实例。
   */
  ctx.on('download/commit', async (placement, next) => {
    if (!enabled() || !(await linkReady) || !hardlink) return next()
    if (!placement.sha1 || !isInstanceMod(placement.savePath)) return next()
    return commit(placement, next)
  })

  ctx.on('mods/removed', () => {
    if (enabled()) void sweep()
  })

  async function avoidCollision(
    target: DownloadFileRequest,
    claimed: Set<string>
  ): Promise<DownloadFileRequest> {
    // 摘要统一小写：库存文件名、比较与后缀都按同一份表示，避免大小写不同的同一文件重复入库
    const sha1 = (target.sha1 ?? '').toLowerCase()
    const keyOf = (file: string): string => path.resolve(file).toLowerCase()
    const claimedKey = keyOf(target.savePath)

    if (!claimed.has(claimedKey) && !existsSync(target.savePath)) {
      claimed.add(claimedKey)
      return target
    }
    if (!claimed.has(claimedKey) && (await sameContent(target.savePath, sha1))) {
      // 实例里已经是同一个文件：保留原名，管线的摘要校验会直接跳过下载
      claimed.add(claimedKey)
      return target
    }

    const dir = path.dirname(target.savePath)
    const extension = path.extname(target.savePath)
    const base = path.basename(target.savePath, extension)
    const tag = sha1.slice(0, 8)
    for (let index = 0; index < MAX_SUFFIX; index += 1) {
      const suffix = index === 0 ? ` (${tag})` : ` (${tag}-${index + 1})`
      const candidate = path.join(dir, `${base}${suffix}${extension}`)
      const candidateKey = keyOf(candidate)
      if (claimed.has(candidateKey)) continue
      if (existsSync(candidate) && !(await sameContent(candidate, sha1))) continue
      claimed.add(candidateKey)
      return { ...target, savePath: candidate }
    }

    // 后缀用尽（正常不会发生）：宁可覆盖，也不让一次安装卡死在这里
    claimed.add(claimedKey)
    return target
  }

  async function commit(
    placement: DownloadPlacement,
    next: () => Promise<DownloadPlacementResult>
  ): Promise<DownloadPlacementResult> {
    const sha1 = placement.sha1.toLowerCase()
    const canonical = path.join(storeDir, `${sha1}.jar`)
    const mark = path.basename(canonical)
    let moved = false
    try {
      await mkdir(storeDir, { recursive: true })
      const existing = await stat(canonical).catch(() => null)
      // 库里已有同摘要实体时，刚下载的这份是重复字节，直接丢掉；
      // 大小对不上说明实体损坏（或大小未知），用这次校验过的内容替换
      const reuse =
        existing !== null &&
        existing.isFile() &&
        (placement.size <= 0 || existing.size === placement.size)
      pending.add(mark)
      if (reuse) {
        await rm(placement.savePath, { force: true })
      } else {
        await moveInto(placement.savePath, canonical)
        moved = true
      }
      await link(canonical, placement.savePath)
      return { path: placement.savePath, created: [placement.savePath] }
    } catch (cause) {
      try {
        if (moved) await moveInto(canonical, placement.savePath)
        else if (existsSync(canonical)) await copyFile(canonical, placement.savePath)
      } catch (restoreCause) {
        throw new Error(
          `Mod 内容库写入失败，且无法恢复目标文件：${toMessage(restoreCause)}（原始错误：${toMessage(cause)}）`,
          { cause: restoreCause }
        )
      }
      if (hardlink && linkUnsupported(cause)) {
        hardlink = false
        log.warn('硬链接不可用，之后的 Mod 将按普通文件保存：%s', toMessage(cause))
      }
      return next()
    } finally {
      pending.delete(mark)
    }
  }

  /**
   * 回收没有实例引用的实体。
   *
   * 硬链接本身就是引用计数：剩下一条目录项（`nlink === 1`）说明删除的链接
   * 是最后一条，实体才可以删。正在写入的实体先跳过，避免和 `commit` 抢文件。
   */
  function sweep(): Promise<void> {
    if (sweeping) return sweeping
    sweeping = (async () => {
      try {
        const entries = await readdir(storeDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !STORED_NAME.test(entry.name) || pending.has(entry.name)) continue
          const file = path.join(storeDir, entry.name)
          const info = await stat(file).catch(() => null)
          if (info && info.nlink <= 1) await rm(file, { force: true }).catch(() => undefined)
        }
      } catch {
        /* 库存目录还不存在：没有可回收的内容 */
      }
    })().finally(() => {
      sweeping = null
    })
    return sweeping
  }
}

/** 库存目录只接受用户数据目录内的子目录；越界或为空时退回默认名 */
function resolveStoreDir(userData: string, raw: string): string {
  const root = path.resolve(userData)
  const value = raw.trim()
  const dir = path.resolve(root, value || DEFAULT_DIRECTORY)
  const relative = path.relative(root, dir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.join(root, DEFAULT_DIRECTORY)
  }
  return dir
}

/** 在库存目录所在卷上探测硬链接支持；探测文件随后删除 */
async function probeHardlink(dir: string): Promise<boolean> {
  const base = path.join(dir, `.mics-link-probe-${process.pid}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(base, '')
    await link(base, `${base}.link`)
    await rm(`${base}.link`, { force: true })
    return true
  } catch {
    return false
  } finally {
    await rm(base, { force: true }).catch(() => undefined)
  }
}

/** 同卷用 rename（原子、不复制），跨卷才退回复制 + 删除 */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

/**
 * 错误是否说明「这个卷根本不支持硬链接」。
 *
 * 只有这类错误才永久关闭拦截；`EEXIST`、`EBUSY` 之类是单次失败（并发、文件锁），
 * 下一个文件仍应继续尝试，否则一次偶发失败会让整次安装都退回普通文件。
 */
function linkUnsupported(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code ?? ''
  return code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK'
}

/** 文件内容是否与摘要一致；读不到（不存在、是目录）时按不一致处理 */
async function sameContent(file: string, sha1: string): Promise<boolean> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    return (await hashFile(file)) === sha1
  } catch {
    return false
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export default defineMainPlugin({ name, inject, apply })
