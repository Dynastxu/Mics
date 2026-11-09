import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import {
  isLoaderSourceKind,
  LOADER_LABELS,
  LOADER_SOURCE_KINDS,
  serialEvent,
  SHELL_EXECUTE
} from '@mics/sdk'
import type {
  DownloadEndpoint,
  LoaderPrepareInput,
  LoaderPrepareResult,
  LoaderProvider,
  LoaderRuntime,
  LoaderSource,
  LoaderSourceKind,
  LoadersServiceApi,
  LoaderVersion,
  LoaderVersionQuery,
  ShellExecuteCapability,
  ShellProcess
} from '@mics/sdk'
import { defineMainPlugin } from '@mics/sdk/main'
import { absoluteUrl, matchLoaderUrl, sourceLabel, tailLastLine } from '@mics/sdk/main'
import { findJava } from '@mics/java'

export const name = 'mics.download.loaders'
export const inject = ['ipc', 'storage', 'capabilities', 'host']

/**
 * 加载器注册表。
 *
 * 每个加载器插件只实现自己的版本列表与安装方式；下载与 Java 进程由这里统一
 * 提供，因此加载器插件不需要注入下载管线，也不需要知道实例状态。
 */
class LoadersRegistry extends Service implements LoadersServiceApi {
  private readonly providers = new Map<LoaderSourceKind, LoaderProvider>()
  private readonly pendingLegacy = new Map<LoaderSourceKind, LoaderSource[]>()

  constructor(ctx: Context) {
    super(ctx, 'loaders')
  }

  register(provider: LoaderProvider) {
    this.providers.set(provider.kind, provider)
    const pending = this.pendingLegacy.get(provider.kind)
    if (pending) {
      provider.setSources(pending)
      this.pendingLegacy.delete(provider.kind)
    }
    return () => {
      if (this.providers.get(provider.kind) === provider) this.providers.delete(provider.kind)
    }
  }

  get(kind: LoaderSourceKind): LoaderProvider | undefined {
    return this.providers.get(kind)
  }

  list(): LoaderProvider[] {
    return [...this.providers.values()]
  }

  /** 旧下载插件的加载器源：插件还没注册时先存起来 */
  applyLegacy(sources: LoaderSource[]): void {
    const grouped = new Map<LoaderSourceKind, LoaderSource[]>()
    for (const kind of LOADER_SOURCE_KINDS) grouped.set(kind, [])
    for (const source of sources) {
      if (!isLoaderSourceKind(source?.kind)) continue
      grouped.get(source.kind)?.push(source)
    }
    for (const [kind, list] of grouped) {
      if (list.length === 0) continue
      const provider = this.providers.get(kind)
      if (provider) provider.setSources(list)
      else this.pendingLegacy.set(kind, list)
    }
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 加载器地址 -> 该加载器自己的候选源；不是加载器地址时按直链处理 */
function loaderEndpoints(url: string, sources: LoaderSource[]): DownloadEndpoint[] {
  const match = matchLoaderUrl(url, sources)
  if (!match) return [{ id: `direct:${url}`, label: '直链', url }]

  const endpoints: DownloadEndpoint[] = []
  const seen = new Set<string>()
  for (const [index, source] of sources.entries()) {
    if (!source.enabled || source.kind !== match.kind) continue
    const base = match.role === 'maven' ? source.maven : source.meta
    const candidate = absoluteUrl(base, match.suffix)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    endpoints.push({
      id: `loader:${source.kind}:${index}`,
      label: sourceLabel(source, index),
      url: candidate,
      category: match.role === 'meta' ? 'meta' : 'loader'
    })
  }
  return endpoints.length > 0 ? endpoints : [{ id: `direct:${url}`, label: '直链', url }]
}

/**
 * 运行 Java 进程并等待退出。
 *
 * 安装器没有进度接口；日志长时间不增长就认为卡死，结束进程并把日志交给上层。
 */
function runJavaProcess(
  ctx: Context,
  spec: { args: string[]; cwd: string; logFile: string; requiredMajor: number },
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }

    let javaPath: string
    try {
      javaPath = findJava(spec.requiredMajor).java
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }

    ensureDir(path.dirname(spec.logFile))
    const shell = ctx.capabilities.require<ShellExecuteCapability>(SHELL_EXECUTE)
    let child: ShellProcess | null = null
    let settled = false
    let watcher: ReturnType<typeof setInterval> | null = null
    const stallMs = 180_000
    let lastSize = -1
    let lastGrowth = Date.now()

    function settle(error?: Error): void {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (watcher) {
        clearInterval(watcher)
        watcher = null
      }
      if (error) reject(error)
      else resolve()
    }

    function onAbort(): void {
      child?.kill()
      settle(new Error('已取消'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    watcher = setInterval(() => {
      let size = 0
      try {
        size = statSync(spec.logFile).size
      } catch {
        /* 还没写出日志 */
      }
      if (size !== lastSize) {
        lastSize = size
        lastGrowth = Date.now()
        return
      }
      if (Date.now() - lastGrowth < stallMs) return
      child?.kill()
      settle(new Error(`安装器 ${Math.round(stallMs / 1000)} 秒没有任何输出，已终止`))
    }, 5000)

    void shell
      .spawn({ command: javaPath, args: spec.args, cwd: spec.cwd, logFile: spec.logFile })
      .then((process) => {
        if (settled) {
          process.kill()
          return
        }
        child = process
        process.once('exit', (...args) => {
          const code = args[0]
          if (typeof code === 'number' && code !== 0) settle(new Error(`安装器退出码 ${code}`))
          else settle()
        })
      })
      .catch((cause) => settle(cause instanceof Error ? cause : new Error(String(cause))))
  })
}

/** 给加载器插件的运行时：文件走下载管线，Java 走 shell 能力 */
function createRuntime(
  ctx: Context,
  registry: LoadersRegistry,
  input: LoaderPrepareInput,
  log: ReturnType<Context['logger']>
): LoaderRuntime {
  const provider = registry.get(input.kind)
  if (!provider) throw new Error(`未安装 ${LOADER_LABELS[input.kind]} 加载器插件`)
  const sources = provider.sources()

  return {
    async download(url, target, sha1 = '', size = 0, options = {}) {
      const result = await serialEvent(ctx, 'download/addFiles', {
        jobId: input.jobId,
        files: [
          {
            label: path.basename(target),
            url,
            savePath: target,
            sha1,
            size,
            race: !options.direct,
            sources:
              options.sources ??
              (options.direct
                ? [{ id: `direct:${url}`, label: '直链', url }]
                : loaderEndpoints(url, sources))
          }
        ]
      })
      if (!result) throw new Error('下载管线未启用')
      const results = await serialEvent(ctx, 'download/awaitFiles', {
        jobId: input.jobId,
        taskIds: result.taskIds
      })
      const file = results?.[0]
      if (!file || file.state !== 'done') throw new Error(file?.error ?? '下载失败')
    },
    runJava: async (spec) => {
      // 安装器没有进度接口：运行期间把日志末行和已用时间报给下载页
      ctx.emit('download/report', input.jobId, {
        note: `安装 ${LOADER_LABELS[input.kind]}`
      })
      const started = Date.now()
      let lastLine = ''
      const timer = setInterval(() => {
        void tailLastLine(spec.logFile)
          .then((line) => {
            if (line) lastLine = line
            const seconds = Math.floor((Date.now() - started) / 1000)
            const detail = lastLine ? `：${lastLine}` : ''
            ctx.emit('download/report', input.jobId, {
              note: `安装 ${LOADER_LABELS[input.kind]}（已 ${seconds} 秒）${detail}`
            })
          })
          .catch(() => undefined)
      }, 1500)
      try {
        await runJavaProcess(ctx, spec, input.signal)
      } finally {
        clearInterval(timer)
      }
    },
    report: (note, percent) => {
      ctx.emit('download/report', input.jobId, { note, percent })
    },
    log: (level, message) => {
      if (level === 'warn') log.warn('[%s] %s', LOADER_LABELS[input.kind], message)
      else log.info('[%s] %s', LOADER_LABELS[input.kind], message)
    }
  }
}

/** 旧下载插件的加载器源配置 -> 各加载器自己的配置 */
function importLegacySources(registry: LoadersRegistry, sources: LoaderSource[]): void {
  registry.applyLegacy(sources)
}

export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.loaders')
  const registry = new LoadersRegistry(ctx)

  ctx.on('loader/versions', async (request: LoaderVersionQuery): Promise<LoaderVersion[]> => {
    const provider = registry.get(request.kind)
    if (!provider) throw new Error(`未安装 ${LOADER_LABELS[request.kind]} 加载器插件`)
    return provider.listVersions(
      request.gameVersion,
      request.signal ?? new AbortController().signal
    )
  })

  ctx.on('loader/prepare', async (request: LoaderPrepareInput): Promise<LoaderPrepareResult> => {
    const provider = registry.get(request.kind)
    if (!provider) throw new Error(`未安装 ${LOADER_LABELS[request.kind]} 加载器插件`)
    const runtime = createRuntime(ctx, registry, request, log)
    return provider.prepare(request, runtime)
  })

  ctx.ipc.handle<{ gameVersion?: string; kind?: string }>('loaders/versions', async (params) => {
    if (!isLoaderSourceKind(params?.kind)) throw new Error('不支持的加载器类型')
    const gameVersion = typeof params?.gameVersion === 'string' ? params.gameVersion : ''
    if (!gameVersion) throw new Error('无效的游戏版本')

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 20_000)
    try {
      return await registry.get(params.kind)?.listVersions(gameVersion, abort.signal)
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  })

  /** 设置页只关心来源标识；各加载器的配置仍由各自插件持有 */
  ctx.ipc.handle('loaders/sources/get', (): LoaderSource[] => {
    const sources: LoaderSource[] = []
    for (const kind of LOADER_SOURCE_KINDS) {
      const provider = registry.get(kind)
      if (!provider) continue
      sources.push(...provider.sources())
    }
    return sources
  })

  ctx.ipc.handle<{ sources: LoaderSource[] }>('loaders/sources/set', ({ sources }) => {
    const grouped = new Map<LoaderSourceKind, LoaderSource[]>()
    for (const kind of LOADER_SOURCE_KINDS) grouped.set(kind, [])
    for (const source of Array.isArray(sources) ? sources : []) {
      if (!isLoaderSourceKind(source?.kind)) continue
      grouped.get(source.kind)?.push(source)
    }
    for (const [kind, list] of grouped) {
      registry.get(kind)?.setSources(list)
    }
  })

  // 从旧下载插件导入一次加载器源配置；各加载器自己的默认值在导入前已经就绪。
  if (!ctx.storage.get<boolean>('legacyImported')) {
    void serialEvent(ctx, 'download/legacy-config')
      .then((legacy) => {
        const sources = legacy?.loaderSources
        if (Array.isArray(sources) && sources.length > 0) importLegacySources(registry, sources)
        ctx.storage.set('legacyImported', true)
      })
      .catch(() => undefined)
  }
}

export default defineMainPlugin({ name, inject, apply })
