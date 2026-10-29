import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginId, PluginRecord } from '@mics/sdk'
import { PluginUninstallError } from '@mics/sdk'

/** 卸载脚本超时：坏脚本不能把卸载流程卡死 */
export const UNINSTALL_TIMEOUT_MS = 10_000

/** 插件自己的存储文件 */
export function pluginStorageFile(userDataDir: string, id: PluginId): string {
  return path.join(userDataDir, 'plugin-storage', `${id}.json`)
}

/**
 * 卸载脚本拿到的上下文。
 *
 * 脚本与插件本体权限相同（都是主进程代码），这里提供的只是便利：
 * 它当然也可以直接用 node:fs —— 安装时用户已经信任过这份代码。
 */
export interface UninstallScriptContext {
  id: PluginId
  /** 插件目录；脚本可以读，但不要往里面写（马上就要被删了） */
  dir: string
  /** 插件存储文件的绝对路径 */
  storageFile: string
  /** 存储的当前内容（只读快照） */
  storage: Record<string, unknown>
  log(message: string): void
}

export type UninstallScript = (context: UninstallScriptContext) => unknown

export interface RunUninstallOptions {
  userDataDir: string
  timeoutMs?: number
  log?: (message: string) => void
}

async function readStorage(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 在插件停止之后、删除目录之前执行卸载脚本。
 *
 * 没有声明脚本的插件直接返回——宿主只删本体，插件在目录外留下的东西保留。
 */
export async function runUninstallScript(
  record: PluginRecord,
  options: RunUninstallOptions,
): Promise<void> {
  if (!record.entryUninstall) return
  const { manifest } = record
  const timeoutMs = options.timeoutMs ?? UNINSTALL_TIMEOUT_MS
  const log = options.log ?? (() => {})

  let script: UninstallScript
  try {
    const module = (await import(
      `${pathToFileURL(record.entryUninstall).href}?mics=${Date.now()}`
    )) as Record<string, unknown>
    const candidate = module.default ?? module.run
    if (typeof candidate !== 'function') {
      throw new Error('卸载脚本需要默认导出函数')
    }
    script = candidate as UninstallScript
  } catch (error) {
    throw new PluginUninstallError(
      `卸载脚本加载失败: ${(error as Error).message}`,
      'script',
    )
  }

  const storageFile = pluginStorageFile(options.userDataDir, manifest.id)
  const context: UninstallScriptContext = {
    id: manifest.id,
    dir: record.dir,
    storageFile,
    storage: await readStorage(storageFile),
    log: (message) => log(`[uninstall] ${message}`),
  }

  try {
    await withTimeout(
      Promise.resolve().then(() => script(context)),
      timeoutMs,
      `卸载脚本超时（${timeoutMs}ms）`,
    )
  } catch (error) {
    throw new PluginUninstallError(
      `卸载脚本执行失败: ${(error as Error).message}`,
      'script',
    )
  }
}

/** 删除插件本体与插件自己的存储；失败时提示用户（文件可能被占用） */
export async function removePluginFiles(
  record: PluginRecord,
  userDataDir: string,
): Promise<void> {
  try {
    await rm(record.dir, { recursive: true, force: true })
  } catch (error) {
    throw new PluginUninstallError(
      `删除插件目录失败: ${(error as Error).message}`,
      'files',
    )
  }
  try {
    await rm(pluginStorageFile(userDataDir, record.manifest.id), { force: true })
  } catch {
    // 存储文件删不掉不该让整个卸载失败：目录已经没了，残留的 JSON 不会再被读取
  }
}
