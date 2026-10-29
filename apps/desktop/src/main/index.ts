import { app, dialog, Menu } from 'electron'
import * as Cordis from 'cordis'
import { Context } from 'cordis'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ID } from '@mics/sdk'
import type { KernelConfig, KernelModule } from '@mics/sdk'
import type { PluginRoot } from '@mics/plugin-loader'
import { importPluginEntry, scanPlugins } from '@mics/plugin-loader'
import { createAppInfo, loadBootConfig, resolvePluginRoots } from './config'
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
  // 窗口装饰（标题栏 / 菜单栏 / 窗口按钮）全部由渲染器自绘，不要系统菜单
  Menu.setApplicationMenu(null)
  registerWindowControls()

  const boot = loadBootConfig()
  const resolvedRoots = resolvePluginRoots(boot.pluginRoots)

  // 第三方插件落在用户数据目录：安装目录通常是只读的，不能往那里写
  const userPluginRoot = path.join(app.getPath('userData'), 'plugins')
  mkdirSync(userPluginRoot, { recursive: true })

  // MICS_PLUGIN_ROOTS 可能把用户目录也列进来；同一个目录只扫一次，否则会自报冲突
  const pluginRoots = resolvedRoots.filter(
    (dir) => path.resolve(dir).toLowerCase() !== path.resolve(userPluginRoot).toLowerCase(),
  )

  // 内置根在前：同 id 时内置胜出，第三方插件会被当成冲突跳过
  const roots: PluginRoot[] = [
    ...pluginRoots.map((dir) => ({ dir, source: 'builtin' as const })),
    { dir: userPluginRoot, source: 'user' as const },
  ]

  const scan = await scanPlugins(roots)
  for (const failure of scan.errors) {
    console.warn(`[mics] 跳过插件 ${failure.dir}：${failure.errors.join('; ')}`)
  }
  for (const record of scan.plugins) {
    for (const warning of record.warnings) {
      console.warn(`[mics] ${record.manifest.id}：${warning}`)
    }
  }

  const protocol = registerPluginProtocol(scan.plugins)

  const kernelRecord = scan.plugins.find((record) => record.manifest.id === boot.kernel)
  if (!kernelRecord) throw new Error(`未找到内核插件 ${boot.kernel}`)
  if (!kernelRecord.entryMain) {
    throw new Error(`内核插件 ${boot.kernel} 缺少 main 入口（先执行 pnpm build:plugins）`)
  }

  const kernelModule = await importPluginEntry(kernelRecord.entryMain)
  const kernel = (kernelModule.default ?? kernelModule) as unknown as KernelModule | undefined
  if (!kernel || typeof kernel.apply !== 'function') {
    throw new Error(`内核插件 ${boot.kernel} 没有导出 cordis 插件`)
  }

  const config: KernelConfig = {
    app: createAppInfo(),
    kernel: boot.kernel,
    plugins: scan.plugins,
    pluginRoots,
    userPluginRoot,
    userDataDir: app.getPath('userData'),
    disabled: boot.disabled,
    // 安装 / 卸载之后内核会回调这里，让 mics-plugin:// 立刻认识新目录
    host: { syncPluginDirs: (dirs) => protocol.sync(dirs) },
  }

  const root = new Context()
  // 内核插件自己的作用域：pluginId 会向下继承给内核提供的所有服务
  const kernelScope = root.extend({ [PLUGIN_ID]: boot.kernel }) as Context
  await kernelScope.plugin(kernel, config)

  const window = createMainWindow()
  await loadRenderer(window)
}

app.whenReady().then(async () => {
  try {
    await start()
  } catch (error) {
    console.error('[mics] 启动失败', error)
    dialog.showErrorBox(
      'Mics 启动失败',
      error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
