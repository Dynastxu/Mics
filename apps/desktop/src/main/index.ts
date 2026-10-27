import { app, dialog, Menu } from 'electron'
import { Context } from 'cordis'
import { PLUGIN_ID } from '@mics/sdk'
import type { KernelConfig, KernelModule } from '@mics/sdk'
import { importPluginEntry, scanPlugins } from '@mics/plugin-loader'
import { createAppInfo, loadBootConfig, resolvePluginRoots } from './config'
import { registerPluginProtocol, registerPrivilegedSchemes } from './protocol'
import { createMainWindow, loadRenderer } from './window'
import { registerWindowControls } from './windowControls'


// 自定义协议必须在 app ready 之前注册
registerPrivilegedSchemes()

/**
 * bootstrap —— 整个应用里唯一不是插件的部分。
 *
 * 它只做四件事：
 *   1. 找到并解析插件目录（读 plugin.json）
 *   2. 创建 cordis 根 Context
 *   3. 把「内核插件」挂上去（内核也是插件）
 *   4. 打开窗口（窗口装饰由渲染器自绘，这里只提供控制通道）
 */
async function start(): Promise<void> {
  // 窗口装饰（标题栏 / 菜单栏 / 窗口按钮）全部由渲染器自绘，不要系统菜单
  Menu.setApplicationMenu(null)
  registerWindowControls()

  const boot = loadBootConfig()
  const pluginRoots = resolvePluginRoots(boot.pluginRoots)

  const scan = await scanPlugins(pluginRoots)
  for (const failure of scan.errors) {
    console.warn(`[mics] 跳过插件 ${failure.dir}：${failure.errors.join('; ')}`)
  }
  for (const record of scan.plugins) {
    for (const warning of record.warnings) {
      console.warn(`[mics] ${record.manifest.id}：${warning}`)
    }
  }

  registerPluginProtocol(scan.plugins)

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
    userDataDir: app.getPath('userData'),
    disabled: boot.disabled,
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
