import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PluginRecord } from '@mics/sdk'
import { readPluginDirectory, STAGING_DIR } from './discovery'

/** 安装失败：原因已经是可以直接展示给用户的文案 */
export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginInstallError'
  }
}

export interface InstallPluginOptions {
  /** 用户选中的文件夹 */
  sourceDir: string
  /** 第三方插件根目录（userData/plugins） */
  pluginsDir: string
  /** 内置插件 id：第三方不能占用 */
  reservedIds?: Iterable<string>
}

export interface InstallPluginResult {
  record: PluginRecord
  /** 同 id 已安装，本次是升级 */
  upgraded: boolean
}

/** child 是否位于 parent 之内（含自身）；Windows 路径大小写不敏感 */
function isInside(parent: string, child: string): boolean {
  const base = path.resolve(parent).toLowerCase()
  const target = path.resolve(child).toLowerCase()
  return target === base || target.startsWith(`${base}${path.sep}`)
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把一个文件夹安装成第三方插件。
 *
 * 事务顺序：复制到 `.staging` → 在暂存目录里重新校验 → 旧版本让位 → 原子 rename。
 * 任何一步失败都会清掉暂存目录；旧版本只有在替换成功后才删除，所以升级失败
 * 不会把用户已装的插件弄丢。
 */
export async function installPluginFromDirectory(
  options: InstallPluginOptions,
): Promise<InstallPluginResult> {
  const { sourceDir, pluginsDir } = options
  const reserved = new Set(options.reservedIds ?? [])

  if (!(await isDirectory(sourceDir))) {
    throw new PluginInstallError('请选择一个文件夹')
  }
  if (isInside(pluginsDir, sourceDir)) {
    throw new PluginInstallError('不能从插件目录内部安装：请选择插件作者提供的文件夹')
  }

  const inspection = await readPluginDirectory(sourceDir, 'user', true)
  if (!inspection.record) {
    throw new PluginInstallError(inspection.errors.join('；') || '插件清单无效')
  }
  const { manifest } = inspection.record
  if (reserved.has(manifest.id)) {
    throw new PluginInstallError(`插件 id ${manifest.id} 属于内置插件，不能安装同名插件`)
  }

  const stamp = Date.now().toString(36)
  const stagingRoot = path.join(pluginsDir, STAGING_DIR)
  const staging = path.join(stagingRoot, `${manifest.id}.${stamp}`)
  const target = path.join(pluginsDir, manifest.id)
  const backup = path.join(stagingRoot, `${manifest.id}.old.${stamp}`)

  await mkdir(stagingRoot, { recursive: true })
  await rm(staging, { recursive: true, force: true })

  try {
    // dereference：把符号链接展开成真实内容，装进去的是文件而不是指向外部的链接
    await cp(sourceDir, staging, { recursive: true, dereference: true })

    // 复制之后再校验一次：确认复制结果自洽，且入口都在插件目录内
    const staged = await readPluginDirectory(staging, 'user', true)
    if (!staged.record) {
      throw new PluginInstallError(staged.errors.join('；') || '插件清单在复制后校验失败')
    }

    const upgraded = await isDirectory(target)
    if (upgraded) await rename(target, backup)
    try {
      await rename(staging, target)
    } catch (error) {
      // 替换失败：把旧版本放回去，目录状态与安装前一致
      if (upgraded) await rename(backup, target).catch(() => {})
      throw error
    }
    await rm(backup, { recursive: true, force: true })

    const installed = await readPluginDirectory(target, 'user', true)
    if (!installed.record) {
      throw new PluginInstallError(installed.errors.join('；') || '安装后的插件校验失败')
    }
    return { record: installed.record, upgraded }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (error instanceof PluginInstallError) throw error
    throw new PluginInstallError(`安装失败: ${(error as Error).message}`)
  }
}
