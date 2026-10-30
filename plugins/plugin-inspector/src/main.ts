import { BrowserWindow, dialog, type MessageBoxOptions, type OpenDialogOptions } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import type {
  PluginId,
  PluginInstallOutcome,
  PluginInstallSummary,
  PluginUninstallOutcome,
} from '@mics/sdk'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeCapability(plugin: PluginInstallSummary): string {
  if (plugin.hasMain && plugin.hasRenderer) return '页面 + 后台'
  if (plugin.hasMain) return '仅后台'
  if (plugin.hasRenderer) return '仅页面'
  return '仅清单'
}

async function openFolder(): Promise<string | undefined> {
  const window = BrowserWindow.getFocusedWindow()
  const options: OpenDialogOptions = {
    title: '选择插件文件夹',
    buttonLabel: '选择',
    properties: ['openDirectory'],
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return undefined
  return result.filePaths[0]
}

async function confirm(options: MessageBoxOptions): Promise<boolean> {
  const window = BrowserWindow.getFocusedWindow()
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

/**
 * 插件管理的主进程部分。
 *
 * 页面碰不到文件，所以「选文件夹、确认、安装、卸载」都在这里：
 *   - 安装 = 读清单 → 展示来源与权限 → 用户确认 → 复制到用户插件目录（装完禁用）
 *   - 卸载 = 确认 → 停用 → 卸载脚本 → 删除本体与存储
 */
export const name = 'mics.plugin-inspector'
/** cordis 要求显式声明要用到的服务，否则 ctx.ipc / ctx.plugins 会抛 "without inject" */
export const inject = ['ipc', 'plugins']

export function apply(ctx: Context): void {
  ctx.ipc.handle('plugin-manager/install', async (): Promise<PluginInstallOutcome> => {
    // 必须通过 ctx.plugins 调用：服务方法依赖 this，取出来单独调用会丢掉接收者
    if (!ctx.plugins.inspect || !ctx.plugins.install) {
      return { status: 'failed', message: '内核未提供安装能力' }
    }

    const dir = await openFolder()
    if (!dir) return { status: 'cancelled' }

    let preview: PluginInstallSummary
    try {
      preview = await ctx.plugins.inspect(dir)
    } catch (error) {
      return { status: 'failed', message: messageOf(error) }
    }

    const lines = [
      `${preview.name} · ${preview.id} · v${preview.version}`,
      preview.author ? `作者：${preview.author}` : '',
      `能力：${describeCapability(preview)}`,
      preview.hasUninstall ? '包含卸载脚本（卸载时会清理插件自己创建的内容）' : '',
      preview.installedVersion
        ? `将替换已安装的 v${preview.installedVersion}，安装后保持禁用`
        : '安装后默认禁用，需要手动启用',
      preview.hasMain
        ? '风险提示：主进程插件拥有与 Mics 相同的权限，可以读写文件、联网与执行命令。'
        : '',
      ...preview.warnings.map((warning) => `注意：${warning}`),
    ].filter(Boolean)

    const confirmed = await confirm({
      type: preview.hasMain ? 'warning' : 'question',
      title: '安装插件',
      message: `安装 ${preview.name}？`,
      detail: lines.join('\n'),
      buttons: ['安装', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (!confirmed) return { status: 'cancelled' }

    try {
      const result = await ctx.plugins.install(dir)
      return { status: 'installed', plugin: result.plugin, upgraded: result.upgraded }
    } catch (error) {
      return { status: 'failed', message: messageOf(error) }
    }
  })

  ctx.ipc.handle<{ id: PluginId; force?: boolean }>(
    'plugin-manager/uninstall',
    async ({ id, force }): Promise<PluginUninstallOutcome> => {
      const info = ctx.plugins.get(id)
      if (!info) return { status: 'failed', id, message: `未找到插件 ${id}`, retryable: false }
      // 同样要通过 ctx.plugins 调用，否则服务方法会丢失 this
      if (!ctx.plugins.uninstall) {
        return { status: 'failed', id, message: '内核未提供卸载能力', retryable: false }
      }
      if (info.source === 'builtin') {
        return { status: 'failed', id, message: `内置插件 ${id} 不可卸载`, retryable: false }
      }

      if (!force) {
        const confirmed = await confirm({
          type: 'warning',
          title: '卸载插件',
          message: `卸载 ${info.name}？`,
          detail: [
            `插件目录、插件存储与启用记录都会被删除，之后不会再出现在插件列表中。`,
            info.hasUninstall
              ? '确认后会先执行插件的卸载脚本，清理它自己在插件目录之外创建的内容。'
              : '这个插件没有声明卸载脚本：宿主只删除插件本体，它在插件目录之外创建的内容会保留。',
          ].join('\n'),
          buttons: ['卸载', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (!confirmed) return { status: 'cancelled' }
      }

      try {
        await ctx.plugins.uninstall(id, { force })
        return { status: 'uninstalled', id }
      } catch (error) {
        const stage = (error as { stage?: string }).stage
        return {
          status: 'failed',
          id,
          message: messageOf(error),
          // 只有卸载脚本失败才允许「跳过清理、强制卸载」；删文件失败必须重试
          retryable: stage === 'script',
        }
      }
    },
  )
}

export default defineMainPlugin({ name, inject, apply })
