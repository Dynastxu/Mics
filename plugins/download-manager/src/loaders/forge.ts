import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { LOADER_LABELS } from '@mics/sdk'
import type { LoaderSourceKind, LoaderVersion } from '@mics/sdk'
import { instanceClientJar, instanceVersionJson } from '@mics/sdk/main'
import type { VersionDetail } from '../version'
import { moveTreeInto, tailText } from './fs'
import { prefetchInstallerLibraries } from './installerLibraries'
import { absoluteUrl, OFFICIAL_LOADER_BASES, originOf } from './sources'
import type { LoaderEnvironment, LoaderInstallInput, LoaderInstallPlan, LoaderProvider } from './types'

/**
 * Forge / NeoForge：官方只发布安装器（installer.jar）。
 *
 * 安装器要求一个「类 .minecraft」的目标目录（`versions/`、`libraries/`、
 * `launcher_profiles.json`）。实例目录不是这个形状——一实例一版本，版本档案与
 * 客户端 jar 平铺在实例根——所以安装器跑在实例内的暂存目录里，装完把版本档案、
 * 客户端 jar 搬进实例、库并入共享库目录，暂存目录整体删除。
 */

interface PromotionList {
  promos?: Record<string, unknown>
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Forge promotions_slim.json 的条目：recommended / latest 两档 */
function parseForgePromotions(value: unknown, gameVersion: string): LoaderVersion[] {
  const promos = recordOf(recordOf(value)?.promos) ?? {}
  const recommended = stringOf(promos[`${gameVersion}-recommended`])
  const latest = stringOf(promos[`${gameVersion}-latest`])

  const versions: LoaderVersion[] = []
  if (recommended) {
    versions.push({ id: recommended, gameVersion, channel: 'stable', date: '' })
  }
  if (latest && latest !== recommended) {
    versions.push({
      id: latest,
      gameVersion,
      // 没有 recommended 时，latest 就是唯一可用的版本
      channel: recommended ? 'beta' : 'stable',
      date: '',
    })
  }
  return versions
}

/** BMCLAPI 的 Forge 列表：带完整版本、发布日期与分支 */
function parseBmclForgeVersions(value: unknown, gameVersion: string): LoaderVersion[] {
  if (!Array.isArray(value)) return []
  const versions: LoaderVersion[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = recordOf(entry)
    if (!record) continue
    const mcVersion = stringOf(record.mcversion)
    if (mcVersion && mcVersion !== gameVersion) continue
    const id = stringOf(record.version)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const branch = stringOf(record.branch)
    const modified = stringOf(record.modified)
    versions.push({
      id,
      gameVersion,
      channel: branch === 'latest' || isPrerelease(id) ? 'beta' : 'stable',
      date: modified ? modified.slice(0, 10) : '',
    })
  }
  return versions
}

/**
 * 等待一组请求，但最多等 `graceMs`；到点时返回已经完成的结果。
 *
 * 用于 Forge：BMCLAPI 的列表很快，官方 promotions 很慢，不能为了合并渠道信息
 * 把界面一直卡在加载态。
 */
async function settleWithin<T>(promises: Promise<T>[], graceMs: number): Promise<T[]> {
  const results: T[] = []
  const all = promises.map((promise) =>
    promise.then(
      (value) => { results.push(value) },
      () => undefined,
    ),
  )
  await Promise.race([
    Promise.all(all),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ])
  return results.slice()
}

function mergeLoaderVersions(lists: LoaderVersion[][]): LoaderVersion[] {
  const merged = new Map<string, LoaderVersion>()
  for (const list of lists) {
    for (const version of list) {
      const existing = merged.get(version.id)
      if (!existing) {
        merged.set(version.id, { ...version })
        continue
      }
      // 同一个版本可能来自推荐档和完整列表：保留渠道判断，补齐日期
      if (!existing.date && version.date) existing.date = version.date
    }
  }
  return [...merged.values()].sort((a, b) => compareSegments(b.id, a.id))
}

/** Forge 的列表接口分散在官方与 BMCLAPI，按源类型分别请求后合并 */
async function listForgeVersions(gameVersion: string, env: LoaderEnvironment): Promise<LoaderVersion[]> {
  const requests: Array<Promise<LoaderVersion[]>> = []
  let hasFastSource = false

  for (const source of env.sources) {
    const origin = originOf(source.meta)
    if (!origin) continue

    if (isBmclHost(origin)) {
      hasFastSource = true
      requests.push(
        env
          .fetchJsonUrl<unknown>(`${origin}/forge/minecraft/${encodeURIComponent(gameVersion)}`)
          .then((value) => parseBmclForgeVersions(value, gameVersion)),
      )
      continue
    }

    requests.push(
      env
        .fetchJson<PromotionList>('/net/minecraftforge/forge/promotions_slim.json')
        .then((value) => parseForgePromotions(value, gameVersion)),
    )
  }

  // 有 BMCLAPI 速源时先等 1.5 秒；慢的官方 promotions 继续在后台补渠道信息
  let lists = hasFastSource ? await settleWithin(requests, 1500) : []
  if (lists.length === 0) {
    lists = (await Promise.allSettled(requests))
      .filter((result): result is PromiseFulfilledResult<LoaderVersion[]> =>
        result.status === 'fulfilled',
      )
      .map((result) => result.value)
  }

  const versions = mergeLoaderVersions(lists)
  if (versions.length > 0) return versions

  // 旧版本或只镜像了 maven 的源：从 maven 元数据里筛选该游戏版本的 Forge
  const xml = await env.fetchText('/net/minecraftforge/forge/maven-metadata.xml', 'maven')
  const prefix = `${gameVersion}-`
  return parseMavenVersions(xml)
    .filter((version) => version.startsWith(prefix))
    .sort((a, b) => compareSegments(b, a))
    .map((version) => ({
      id: version.slice(prefix.length),
      gameVersion,
      channel: isPrerelease(version) ? 'beta' : 'stable',
      date: '',
    }))
}

/**
 * NeoForge 的版本号映射到游戏版本：
 * - 21.1.x -> 1.21.1，21.0.x -> 1.21
 * - 47.x 是 1.20.1 的旧坐标
 * - 0.x 是快照构建，第二段就是游戏版本
 * - 26 之后改成独立版本号（26.1 / 26.1.2）
 */
export function neoforgeGameVersion(version: string): string | null {
  const core = version.split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null

  if (major === 0) return parts[1] ?? null
  if (major === 47) return '1.20.1'
  if (major >= 26) {
    const patch = parts[2]
    const base = patch !== undefined && Number(patch) === 0
      ? `${major}.${minor}`
      : `${major}.${minor}${patch ? `.${patch}` : ''}`
    const plus = version.indexOf('+')
    return plus >= 0 ? `${base}-${version.slice(plus + 1)}` : base
  }
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`
}

/** 1.20.1 的旧坐标带 `1.20.1-forge-` 前缀，统一成加载器版本号 */
function normalizeNeoForgeVersion(version: string): string {
  return version.replace(/^1\.20\.1-(?:forge-)?/, '')
}

function isPrerelease(version: string): boolean {
  return /-(beta|alpha|pre|rc)/i.test(version)
}

function compareSegments(a: string, b: string): number {
  const left = a.split(/[.+-]/)
  const right = b.split(/[.+-]/)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftText = left[index] ?? ''
    const rightText = right[index] ?? ''
    const leftNumber = Number(leftText)
    const rightNumber = Number(rightText)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
      continue
    }
    const compared = leftText.localeCompare(rightText)
    if (compared !== 0) return compared
  }
  return 0
}

/** 解析 maven-metadata.xml 里的版本列表（只找 <version> 节点） */
export function parseMavenVersions(xml: string): string[] {
  const versions: string[] = []
  const pattern = /<version>([^<]+)<\/version>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1]?.trim()
    if (value) versions.push(value)
  }
  return versions
}

/** NeoForge 官方版本接口（站点根路径下的 JSON） */
function parseOfficialNeoForgeVersions(value: unknown): string[] {
  const record = recordOf(value)
  const direct = Array.isArray(record?.versions) ? record.versions : []
  const versions = direct.filter((item): item is string => typeof item === 'string')
  if (versions.length > 0) return versions

  // 兼容 Nexus / maven-metadata 包装的形态
  const versioning = recordOf(record?.versioning)
  const nested = Array.isArray(versioning?.versions) ? versioning.versions : []
  return nested.filter((item): item is string => typeof item === 'string')
}

/** BMCLAPI 的 NeoForge 列表：每条带 version 与 mcversion */
function parseBmclNeoForgeVersions(value: unknown, gameVersion: string): string[] {
  if (!Array.isArray(value)) return []
  const versions: string[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (!record) continue
    const version = stringOf(record.version)
    const mcVersion = stringOf(record.mcversion)
    if (!version) continue
    if (mcVersion && mcVersion !== gameVersion) continue
    versions.push(version)
  }
  return versions
}

function isBmclHost(origin: string): boolean {
  return origin.includes('bangbang93.com')
}

/**
 * NeoForge 版本列表。
 *
 * 官方使用站点根路径下的 JSON 接口（maven-metadata.xml 并不一定存在），
 * BMCLAPI 则有专门的 `/neoforge/list/{game}` 接口；两者并行请求、结果合并，
 * 只镜像了 maven 文件的源再退回 maven-metadata.xml。
 */
async function listNeoForgeVersions(gameVersion: string, env: LoaderEnvironment): Promise<LoaderVersion[]> {
  const legacy = gameVersion === '1.20.1'
  const requests: Array<Promise<string[]>> = []
  let hasFastSource = false

  for (const source of env.sources) {
    const origin = originOf(source.meta)
    if (!origin) continue

    if (isBmclHost(origin)) {
      hasFastSource = true
      requests.push(
        env
          .fetchJsonUrl<unknown>(`${origin}/neoforge/list/${encodeURIComponent(gameVersion)}`)
          .then((value) => parseBmclNeoForgeVersions(value, gameVersion)),
      )
      continue
    }

    const api = legacy
      ? '/api/maven/versions/releases/net/neoforged/forge'
      : '/api/maven/versions/releases/net/neoforged/neoforge'
    requests.push(
      env.fetchJsonUrl<unknown>(`${origin}${api}`).then(parseOfficialNeoForgeVersions),
    )
  }

  // 有 BMCLAPI 速源时最多等 2.5 秒，官方接口慢也不会一直卡住
  let lists = hasFastSource ? await settleWithin(requests, 2500) : []
  if (lists.length === 0) {
    lists = (await Promise.allSettled(requests))
      .filter((result): result is PromiseFulfilledResult<string[]> =>
        result.status === 'fulfilled',
      )
      .map((result) => result.value)
  }

  const versions: string[] = lists.flat()
  if (versions.length === 0) {
    try {
      const xml = await env.fetchText(
        legacy
          ? '/net/neoforged/forge/maven-metadata.xml'
          : '/net/neoforged/neoforge/maven-metadata.xml',
        'maven',
      )
      versions.push(...parseMavenVersions(xml))
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error('无法获取 NeoForge 版本列表')
    }
  }

  const seen = new Set<string>()
  const result: LoaderVersion[] = []
  for (const raw of versions) {
    const version = normalizeNeoForgeVersion(raw)
    if (!version || seen.has(version)) continue
    if (neoforgeGameVersion(version) !== gameVersion) continue
    seen.add(version)
    result.push({
      id: version,
      gameVersion,
      channel: isPrerelease(version) ? 'beta' : 'stable',
      date: '',
    })
  }
  return result.sort((a, b) => compareSegments(b.id, a.id))
}

function installerUrl(kind: LoaderSourceKind, gameVersion: string, loaderVersion: string): string {
  if (kind === 'forge') {
    const relative = `/net/minecraftforge/forge/${gameVersion}-${loaderVersion}`
      + `/forge-${gameVersion}-${loaderVersion}-installer.jar`
    return absoluteUrl(OFFICIAL_LOADER_BASES.forge.maven, relative)
  }
  // NeoForge 1.20.1 沿用了 Forge 的 net.neoforged:forge 坐标
  if (gameVersion === '1.20.1' && loaderVersion.startsWith('47.')) {
    const relative = `/net/neoforged/forge/${gameVersion}-${loaderVersion}`
      + `/forge-${gameVersion}-${loaderVersion}-installer.jar`
    return absoluteUrl(OFFICIAL_LOADER_BASES.neoforge.maven, relative)
  }
  return absoluteUrl(
    OFFICIAL_LOADER_BASES.neoforge.maven,
    `/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
  )
}

function readVersionJson(file: string): Promise<VersionDetail | null> {
  return readFile(file, 'utf8')
    .then((text) => {
      const value = JSON.parse(text) as unknown
      const record = recordOf(value)
      return typeof record?.id === 'string' && record.id ? (value as VersionDetail) : null
    })
    .catch(() => null)
}

/**
 * 安装器只认「类 .minecraft」的目标目录，而实例目录不是那个形状：版本档案与
 * 客户端 jar 平铺在实例根（一实例一版本）。因此安装器跑在实例内的暂存目录里，
 * 装完再把产物搬进实例，暂存目录连同安装器临时文件一起删除。
 */
const STAGING_DIR = '.installer'
const WORK_DIR = '.loader'

/** 移动单个文件，目标已存在时覆盖；跨卷时退回复制 */
async function moveFile(from: string, to: string): Promise<void> {
  await rm(to, { force: true }).catch(() => undefined)
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

/**
 * 找到安装器在暂存目录里生成的版本目录。
 *
 * 暂存目录是新建的，版本目录里除了原版只剩安装器写出的那一个；
 * 仍逐个校验版本文件，避免把残留目录当成结果。
 */
async function findInstalledVersion(
  stagingDir: string,
  gameVersion: string,
): Promise<{ id: string; version: VersionDetail }> {
  const versionsDir = path.join(stagingDir, 'versions')
  let entries: Dirent[]
  try {
    entries = await readdir(versionsDir, { withFileTypes: true })
  } catch {
    entries = []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === gameVersion) continue
    const version = await readVersionJson(path.join(versionsDir, entry.name, `${entry.name}.json`))
    if (!version) continue
    return { id: entry.name, version }
  }

  throw new Error('安装器没有生成版本文件，请检查 Java 版本与安装器日志')
}

/**
 * 把安装器产物搬进实例：版本档案与客户端 jar 平铺到实例根，库并入共享库目录。
 *
 * 库不留在实例里：安装器按 `--installClient` 的约定把库写在自己的 `libraries/`，
 * 那是原版 `.minecraft/libraries` 的位置；本项目的共享层在用户数据根，并入后
 * 暂存目录整体删除，同一批 jar 不会存两处。
 */
async function promoteInstallerOutput(
  instanceDir: string,
  versionId: string,
  gameVersion: string,
  stagingDir: string,
  librariesDir: string,
): Promise<void> {
  const installedDir = path.join(stagingDir, 'versions', versionId)
  const versionJson = path.join(installedDir, `${versionId}.json`)
  if (!existsSync(versionJson)) {
    throw new Error('安装器没有生成版本文件，请检查 Java 版本与安装器日志')
  }
  await mkdir(instanceDir, { recursive: true })
  await moveFile(versionJson, instanceVersionJson(instanceDir, versionId))

  // 客户端 jar：安装器自己产出过就用它的，否则用为安装器准备的原版 jar
  const targetJar = instanceClientJar(instanceDir, versionId)
  for (const candidate of [
    path.join(installedDir, `${versionId}.jar`),
    path.join(stagingDir, 'versions', gameVersion, `${gameVersion}.jar`),
  ]) {
    if (!existsSync(candidate)) continue
    await moveFile(candidate, targetJar)
    break
  }

  await moveTreeInto(path.join(stagingDir, 'libraries'), librariesDir, { overwrite: false })
  await rm(stagingDir, { recursive: true, force: true })
  await rm(path.join(instanceDir, WORK_DIR), { recursive: true, force: true })
}

async function installWithInstaller(
  input: LoaderInstallInput,
  env: LoaderEnvironment,
  kind: LoaderSourceKind,
): Promise<LoaderInstallPlan> {
  const { gameVersion, loaderVersion, instanceDir, parent } = input
  const stagingDir = path.join(instanceDir, STAGING_DIR)
  const parentDir = path.join(stagingDir, 'versions', gameVersion)
  const workDir = path.join(instanceDir, WORK_DIR)
  await mkdir(parentDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  // 安装器需要暂存目录里的原版客户端 jar（旧版安装器还会读取版本文件）
  await writeFile(
    path.join(parentDir, `${gameVersion}.json`),
    JSON.stringify(parent, null, 2),
    'utf8',
  )

  const client = parent.downloads?.client
  if (!client?.url) throw new Error('原版版本文件缺少客户端下载地址，无法安装加载器')
  env.log('info', `下载原版客户端 ${gameVersion}.jar（安装器需要）`)
  await env.download(
    client.url,
    path.join(parentDir, `${gameVersion}.jar`),
    client.sha1 ?? '',
    client.size ?? 0,
  )

  // 官方安装器的 ClientInstall 会先检查启动器档案文件；暂存目录是新建的，
  // 这里补一个最小档案，安装完成后随暂存目录一起删除
  await writeFile(
    path.join(stagingDir, 'launcher_profiles.json'),
    JSON.stringify({ profiles: {} }, null, 2),
    'utf8',
  )

  const installerPath = path.join(workDir, 'installer.jar')
  env.log('info', `下载 ${LOADER_LABELS[kind]} 安装器：${gameVersion}-${loaderVersion}`)
  await env.download(installerUrl(kind, gameVersion, loaderVersion), installerPath)

  // 安装器会自己从官方 maven 逐一下载处理器依赖，国内常常只有几 KB/s，整个安装
  // 能拖上几分钟。先用镜像把它声明的库取好放进它自己的 libraries/，安装器发现
  // 文件已在且摘要一致就会跳过下载，只跑处理器（PCL 的「下载 Forge 支持库」同理）。
  try {
    await prefetchInstallerLibraries(installerPath, kind, {
      librariesDir: path.join(stagingDir, 'libraries'),
      sharedLibrariesDir: input.librariesDir,
      download: (url, target, sha1 = '', size = 0) =>
        env.download(url, target, sha1, size, { reportProgress: false }),
      report: (note, percent) => env.report?.(note, percent),
      log: (level, message) => env.log(level, message),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    env.log('warn', `预取安装器依赖库失败，交给安装器自行下载：${message}`)
  }

  const logFile = path.join(workDir, 'installer.log')
  env.log('info', `运行 ${LOADER_LABELS[kind]} 安装器`)
  try {
    await env.runJava({
      // 安装器把可选参数默认成当前目录；显式传入暂存目录更稳妥
      args: ['-jar', installerPath, '--installClient', stagingDir],
      cwd: stagingDir,
      logFile,
      requiredMajor: parent.javaVersion?.majorVersion ?? 8,
    })
  } catch (cause) {
    const detail = await tailText(logFile)
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(detail ? `${message}\n${detail}` : message)
  }

  const installed = await findInstalledVersion(stagingDir, gameVersion)
  await promoteInstallerOutput(instanceDir, installed.id, gameVersion, stagingDir, input.librariesDir)
  env.log('info', `${LOADER_LABELS[kind]} 安装器完成：${installed.id}`)
  return { versionId: installed.id, version: installed.version, mode: 'installer' }
}

export const forgeProvider: LoaderProvider = {
  kind: 'forge',
  listVersions: listForgeVersions,
  install: (input, env) => installWithInstaller(input, env, 'forge'),
}

export const neoforgeProvider: LoaderProvider = {
  kind: 'neoforge',
  listVersions: listNeoForgeVersions,
  install: (input, env) => installWithInstaller(input, env, 'neoforge'),
}
