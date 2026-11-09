import { app, dialog, Menu } from 'electron'
import { pathToFileURL } from 'node:url'
import * as Cordis from 'cordis'
import { Context, type Logger } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import Loader from '@cordisjs/plugin-loader'
import FsService from '@cordisjs/plugin-fs-node'
import Group from '@cordisjs/plugin-group'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ID } from '@mics/sdk'
import type { KernelConfig, KernelModule } from '@mics/sdk'
import type { PluginRoot } from '@mics/plugin-loader'
import { importPluginEntry, scanPlugins } from '@mics/plugin-loader'
import { createAppInfo, loadBootConfig, loadProfile, resolvePluginRoots } from './config'
import { MainWindowHost } from './mainWindowHost'
import { registerPluginProtocol, registerPrivilegedSchemes } from './protocol'
import { createMainWindow, loadRenderer } from './window'
import { registerWindowControls } from './windowControls'

/**
 * 主进程插件产物里的 `cordis` 被编译成 shim（从全局变量取运行时）。
 *
 * 这里必须在 import 任何插件之前注入：内置插件在应用目录、第三方插件在用户目录，
 * 后者向上找不到应用的 node_modules；哪怕找得到，两个 Cordis 实例也会让
 * Service / Context 身份分裂。注入之后，所有主进程插件与宿主共用同一份运行时。
 */
const globals = globalThis as { __MICS_CORDIS__?: typeof Cordis }
globals.__MICS_CORDIS__ = Cordis

/**
 * bootstrap 阶段的日志器。
 *
 * 它挂在根 Context 上，早于任何插件创建。消息先进入 cordis 的日志缓冲区，
 * `mics.logger` 激活时会把这段历史补录进本次启动的日志文件。
 */
let bootstrapLog: Logger | undefined

// 自定义协议必须在 app ready 之前注册
registerPrivilegedSchemes()

/**
 * bootstrap —— 整个应用里唯一不是插件的部分。
 *
 * 它只做四件事：
 *   1. 找到并解析插件目录（内置 + 用户）
 *   2. 创建 cordis 根 Context
 *   3. 把「内核插件」挂上去（内核也是插件）
 *   4. 打开窗口（窗口装饰由渲染器自绘，这里只提供控制通道）
 */
async function start(): Promise<void> {
  const root = new Context()
  // 计时器服务挂在根上下文：插件用 `inject: ['timer']` + `ctx.timeout/interval`，
  // 计时器随插件 fiber 回收，不需要每个插件自己维护 clearTimeout。
  root.plugin(TimerService)
  // 插件树容器（Cordis Loader）。插件的挂载已经走 `ctx.loader.create()`（内核负责），
  // 下一步 Include 会把同一棵树持久化到 userData，因此这里先把两个底层服务挂好。
  root.plugin(Loader, {})
  // 文件 watch 服务：Include 的 watch 模式与后续插件目录热发现都用它
  root.plugin(FsService)
  const log = root.logger('mics')
  bootstrapLog = log

  // 开发构建的控制台输出交给 Cordis 的 exporter（颜色 / %o inspect），
  // 文件日志仍由 mics.logger 负责；生产环境没有终端，不挂。
  if (!app.isPackaged) {
    root.plugin(ConsoleExporter, { levels: { default: 2 } })
  }

  // Cordis HMR：**只在开发构建里动态加载**。
  // 与 vite-plugin-vue-devtools 的区别：后者是构建期插件，跑在 dev server 进程里，
  // 本来就不会进产物；HMR 是运行时插件，跑在应用主进程里，所以必须用动态 import
  // + 构建 external，生产包里只留一个永不执行的 import。
  if (!app.isPackaged) {
    // 前置检查：Electron 里能否真的拿到 Node 内部 ESM 加载器。
    // addon 是 Node-API 模块，装得上不代表 Electron 的内部模块表可达；
    // 拿不到就完全不挂 HMR——否则它会在构造时抛错，日志里只剩一条难懂的告警，
    // 而内核的开发期产物监视才是真正生效的那条路。
    // TODO(HMR): node-addon-require-builtin 按 V8 指纹白名单放行，目前不支持
    // Electron 45.0.0 stable（只支持到 45.0.0-alpha.6）。等 addon 支持后按顺序验证：
    //   1) 确认下面这行输出 `内部加载器=true`；
    //   2) 用 examples/hmr-probe 验证热替换：改 src/main.ts 后 apply 应再次执行、
    //      evaluatedAt 变化且 url 不带 `?mics=`；
    //   3) 验证通过后再决定是否保留内核的产物回退监视（它在 HMR 存在时会自动让位）。
    let internalReady = false
    try {
      const { createRequire } = await import('node:module')
      const req = createRequire(import.meta.url)
      const addon = req('node-addon-require-builtin') as {
        requireBuiltin?: (id: string) => unknown
      }
      internalReady = Boolean(addon.requireBuiltin?.('internal/modules/esm/loader'))
      log.info(
        'HMR 前置检查：addon=可用 · 内部加载器=%s · node=%s · electron=%s',
        internalReady,
        process.versions.node,
        process.versions.electron
      )
    } catch (error) {
      log.info(
        'HMR 前置检查：addon 不可用（%s）',
        error instanceof Error ? error.message : String(error)
      )
    }

    if (internalReady) {
      void import('@cordisjs/plugin-hmr')
        .then(({ default: Hmr }) =>
          Promise.resolve(
            root.plugin(Hmr, {
              // base 传 file: URL：HMR 用它解析相对监视路径，Windows 盘符会被当成 scheme
              base: pathToFileURL(app.getAppPath()).href,
              root: ['../../plugins', '../../examples'],
              ignored: ['**/node_modules'],
              debounce: 200
            })
          )
        )
        .catch((error) => {
          log.warn('HMR 挂载失败：%s', String(error))
        })
    } else {
      log.info('HMR 跳过：Electron 未暴露内部加载器，改用插件产物的自动重载')
    }
  }

  const windowHost = new MainWindowHost({ createWindow: createMainWindow, loadRenderer })

  // 窗口装饰（标题栏 / 菜单栏 / 窗口按钮）全部由渲染器自绘，不要系统菜单
  Menu.setApplicationMenu(null)
  registerWindowControls()

  app.on('window-all-closed', () => {
    // 销毁旧窗口与创建新窗口可能落在同一轮事件里：已有新窗口时不能退出
    if (windowHost.state().exists) return
    // 低内存托盘模式销毁了最后一个窗口：应用留在后台，托盘菜单负责恢复 / 退出
    if (windowHost.shouldKeepAlive()) {
      log.info('主窗口已销毁，应用保持后台运行')
      return
    }
    log.info('所有窗口已关闭，退出应用')
    app.quit()
  })
  app.on('before-quit', () => {
    windowHost.prepareQuit()
    log.info('应用即将退出')
  })
  app.on('render-process-gone', (_event, _contents, details) => {
    const message = `渲染进程退出：${details.reason}（exitCode=${details.exitCode}）`
    // clean-exit 是正常销毁窗口，不是崩溃
    if (details.reason === 'clean-exit') log.info(message)
    else log.error(message)
  })

  log.info(
    'MICS %s 启动 · Electron %s · Node %s · %s/%s',
    app.getVersion(),
    process.versions.electron ?? '-',
    process.versions.node,
    process.platform,
    process.arch
  )
  log.info('应用目录 %s', app.getAppPath())
  log.info('用户数据目录 %s', app.getPath('userData'))

  const boot = loadBootConfig((message) => log.warn(message))
  const profile = boot.profile
    ? loadProfile(boot.profile, (message) => log.warn(message))
    : undefined
  const resolvedRoots = resolvePluginRoots(boot.pluginRoots)

  // 第三方插件落在用户数据目录：安装目录通常是只读的，不能往那里写
  const userPluginRoot = path.join(app.getPath('userData'), 'plugins')
  mkdirSync(userPluginRoot, { recursive: true })

  // MICS_PLUGIN_ROOTS 可能把用户目录也列进来；同一个目录只扫一次，否则会自报冲突
  const pluginRoots = resolvedRoots.filter(
    (dir) => path.resolve(dir).toLowerCase() !== path.resolve(userPluginRoot).toLowerCase()
  )

  // 内置根在前：同 id 时内置胜出，第三方插件会被当成冲突跳过
  const roots: PluginRoot[] = [
    ...pluginRoots.map((dir) => ({ dir, source: 'builtin' as const })),
    { dir: userPluginRoot, source: 'user' as const }
  ]

  log.info(
    '启动配置：内核 %s · profile %s · 禁用 %d 个插件',
    boot.kernel,
    boot.profile ?? '无',
    boot.disabled.length
  )
  log.info('插件根目录：%s', roots.map((item) => item.dir).join('、'))

  const scan = await scanPlugins(roots, { builtinVersion: app.getVersion() })
  for (const failure of scan.errors) {
    log.warn('跳过插件 %s：%s', failure.dir, failure.errors.join('; '))
  }
  for (const record of scan.plugins) {
    for (const warning of record.warnings) {
      log.warn('%s：%s', record.manifest.id, warning)
    }
  }
  const userPlugins = scan.plugins.filter((record) => record.source === 'user').length
  log.info(
    '插件扫描完成：%d 个（内置 %d，第三方 %d），%d 个目录无法加载',
    scan.plugins.length,
    scan.plugins.length - userPlugins,
    userPlugins,
    scan.errors.length
  )

  const protocol = registerPluginProtocol(scan.plugins)

  // Cordis 内建：Group 通过 `cordis:` 前缀挂载，不依赖安装目录里的包。
  // Group 提供 isolate 域（一组 entry 共享 realm），当前没有子树需要隔离——
  // mics 的服务按 pluginId 归属即可，强行隔离会切断插件对内核服务的注入；
  // 先注册内建，等多窗口 / 多实例需要 realm 时再使用。
  await root.inject(['loader'], () => {})
  const loader = root.get('loader') as { builtins?: Record<string, unknown> } | undefined
  if (loader) {
    loader.builtins = loader.builtins ?? {}
    loader.builtins.group = Group
  } else {
    log.warn('Loader 不可用：插件无法挂载')
  }

  const kernelRecord = scan.plugins.find((record) => record.manifest.id === boot.kernel)
  if (!kernelRecord) throw new Error(`未找到内核插件 ${boot.kernel}`)
  if (!kernelRecord.entryMain) {
    throw new Error(`内核插件 ${boot.kernel} 缺少 main 入口（先执行 pnpm build:plugins）`)
  }
  log.info(
    '内核插件 %s v%s：%s',
    boot.kernel,
    kernelRecord.manifest.version,
    kernelRecord.entryMain
  )

  const kernelModule = await importPluginEntry(kernelRecord.entryMain)
  const kernel = (kernelModule.default ?? kernelModule) as unknown as KernelModule | undefined
  if (!kernel || typeof kernel.apply !== 'function') {
    throw new Error(`内核插件 ${boot.kernel} 没有导出 cordis 插件`)
  }

  const config: KernelConfig = {
    app: createAppInfo(boot.profile),
    kernel: boot.kernel,
    sandbox: boot.sandbox,
    plugins: scan.plugins,
    pluginRoots,
    userPluginRoot,
    userDataDir: app.getPath('userData'),
    disabled: boot.disabled,
    // 插件树持久化文件：必须位于可写目录，`resources/` 打包后是只读的
    treeFile: path.join(app.getPath('userData'), 'cordis.yml'),
    // profile 只做「启用集合 + 设置默认值」；文件缺失时退回空 profile
    profile,
    // 首次扫描失败的目录带进内核，诊断报告里能一并展示清单错误
    scanErrors: scan.errors,
    // 安装 / 卸载之后内核会回调这里，让 mics-plugin:// 立刻认识新目录
    // mainWindow 把窗口生命周期交给内核的 mainWindow 服务（低内存托盘用）
    host: {
      syncPluginDirs: (dirs) => protocol.sync(dirs),
      mainWindow: windowHost
    }
  }

  // 内核插件自己的作用域：pluginId 会向下继承给内核提供的所有服务
  const kernelScope = root.extend({ [PLUGIN_ID]: boot.kernel }) as Context
  await kernelScope.plugin(kernel, config)
  log.info('内核已挂载，启动插件将在后台激活')

  log.info('正在创建主窗口')
  // 首次启动按布局的 defaultView 打开；从托盘恢复时才带 restore=1
  await windowHost.show({ restore: false })
  log.info('主界面已加载')
}

app.whenReady().then(async () => {
  try {
    await start()
  } catch (error) {
    bootstrapLog?.error('启动失败', error)
    console.error('[mics] 启动失败', error)
    dialog.showErrorBox(
      'Mics 启动失败',
      error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
    )
    app.quit()
  }
})
