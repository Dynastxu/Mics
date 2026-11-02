import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import type { Context } from 'cordis'
import { defineMainPlugin } from '@mics/sdk/main'
import type {
  PluginId,
  PluginInstallOutcome,
  PluginInstallSelection,
  PluginUninstallOutcome
} from '@mics/sdk'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 系统文件选择器是唯一保留的系统窗口：目录选择没有应用内替代品 */
async function openFolder(): Promise<string | undefined> {
  const window = BrowserWindow.getFocusedWindow()
  const options: OpenDialogOptions = {
    title: '选择插件文件夹',
    buttonLabel: '选择',
    properties: ['openDirectory']
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return undefined
  return result.filePaths[0]
}

/**
 * 插件管理的主进程部分。
 *
 * 页面碰不到文件，所以「选文件夹、读清单、安装、卸载」都在这里；确认由渲染端的
 * 内部确认框完成（`@mics/ui` 的 ConfirmDialog），主进程不再弹系统消息框：
 *   - 安装 = 选目录 + 读清单（select）→ 渲染端确认 → 复制到用户插件目录（装完禁用）
 *   - 卸载 = 渲染端确认 → 停用 → 卸载脚本 → 删除本体与存储
 */
export const name = 'mics.plugin-inspector'
/** cordis 要求显式声明要用到的服务，否则 ctx.ipc / ctx.plugins 会抛 "without inject" */
export const inject = ['ipc', 'plugins']

export function apply(ctx: Context): void {
  ctx.ipc.handle('plugin-manager/select', async (): Promise<PluginInstallSelection> => {
    // 必须通过 ctx.plugins 调用：服务方法依赖 this，取出来单独调用会丢掉接收者
    if (!ctx.plugins.inspect) {
      return { status: 'failed', message: '内核未提供安装能力' }
    }

    const dir = await openFolder()
    if (!dir) return { status: 'cancelled' }

    try {
      const plugin = await ctx.plugins.inspect(dir)
      return { status: 'selected', dir, plugin }
    } catch (error) {
      return { status: 'failed', message: messageOf(error) }
    }
  })

  ctx.ipc.handle<{ dir?: unknown } | undefined>(
    'plugin-manager/install',
    async (params): Promise<PluginInstallOutcome> => {
      if (!ctx.plugins.install) {
        return { status: 'failed', message: '内核未提供安装能力' }
      }
      const dir = typeof params?.dir === 'string' ? params.dir : ''
      if (!dir) return { status: 'failed', message: '未选择插件目录' }

      try {
        const result = await ctx.plugins.install(dir)
        return { status: 'installed', plugin: result.plugin, upgraded: result.upgraded }
      } catch (error) {
        return { status: 'failed', message: messageOf(error) }
      }
    }
  )

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
          retryable: stage === 'script'
        }
      }
    }
  )
}

export default defineMainPlugin({ name, inject, apply })
