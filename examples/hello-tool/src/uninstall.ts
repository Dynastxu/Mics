import { rm } from 'node:fs/promises'
import { app } from 'electron'
import path from 'node:path'
import type { UninstallScriptContext } from '@mics/plugin-loader'

/**
 * 卸载脚本：清理插件在插件目录之外创建的内容。
 *
 * 宿主只知道插件目录和插件存储，不知道插件把文件放到了哪里——所以清理必须由
 * 插件自己声明。这个示例把文件写在 <userData>/hello-tool，卸载时连同目录删掉。
 */
export default async function uninstall(context: UninstallScriptContext): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'hello-tool')
  context.log(`删除示例插件的外部文件：${dir}`)
  await rm(dir, { recursive: true, force: true })
}
