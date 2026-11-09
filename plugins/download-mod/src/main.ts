import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import { INVALID_INSTANCE_NAME_TEST, serialEvent, validateInstanceName } from '@mics/sdk'
import type { DownloadEndpoint, ModInstallRequest } from '@mics/sdk'
import { defineMainPlugin, instancesRoot } from '@mics/sdk/main'

export const name = 'mics.download.mod'
export const inject = ['ipc', 'host']

/**
 * Mod 安装：一个文件写进多个实例的 `mods/` 目录。
 *
 * 只做目标分析与任务登记；真正的传输、暂停、取消、重试都归下载管线。
 */
export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.mod')

  function instanceDirOf(name: string): string {
    return path.join(instancesRoot(ctx.host.paths.userData), name)
  }

  ctx.ipc.handle<ModInstallRequest>('mods/install', async (request) => {
    const file = request?.file
    if (!file) throw new Error('缺少 Mod 文件信息')

    const rawUrl = typeof file.url === 'string' ? file.url.trim() : ''
    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      throw new Error('无效的 Mod 下载地址')
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('Mod 下载地址必须使用 HTTP(S)')
    }

    const rawName = typeof file.fileName === 'string' ? file.fileName : ''
    const fileName = path.basename(rawName)
    if (
      !fileName ||
      fileName !== rawName ||
      !/\.jar$/i.test(fileName) ||
      INVALID_INSTANCE_NAME_TEST.test(fileName)
    ) {
      throw new Error('无效的 Mod 文件名')
    }

    const rawSha1 = typeof file.sha1 === 'string' ? file.sha1.trim().toLowerCase() : ''
    const sha1 = /^[0-9a-f]{40}$/.test(rawSha1) ? rawSha1 : ''
    const size =
      typeof file.size === 'number' && Number.isFinite(file.size) ? Math.max(0, file.size) : 0

    const requested = Array.isArray(request?.instanceNames) ? request.instanceNames : []
    const names = [...new Set(requested.filter((name): name is string => typeof name === 'string'))]
    if (names.length === 0) throw new Error('请选择至少一个实例')
    if (names.length > 64) throw new Error('一次最多安装到 64 个实例')

    const targets = new Map<string, { instanceName: string; target: string }>()
    for (const rawInstance of names) {
      const check = validateInstanceName(rawInstance)
      if (!check.ok || check.name !== rawInstance) {
        throw new Error(`无效的实例名称：${rawInstance}`)
      }
      const instanceDir = instanceDirOf(rawInstance)
      if (!existsSync(instanceDir) || !statSync(instanceDir).isDirectory()) {
        throw new Error(`实例「${rawInstance}」不存在`)
      }
      const key = process.platform === 'win32' ? rawInstance.toLowerCase() : rawInstance
      targets.set(key, {
        instanceName: rawInstance,
        target: path.join(instanceDir, 'mods', fileName)
      })
    }

    const title =
      typeof request?.title === 'string' && request.title.trim()
        ? request.title.trim().slice(0, 120)
        : fileName
    const detail =
      typeof request?.detail === 'string' && request.detail.trim()
        ? request.detail.trim().slice(0, 80)
        : `${targets.size} 个实例`

    const handle = await serialEvent(ctx, 'download/create', {
      title,
      detail,
      kind: 'mod',
      autoFinish: true,
      data: { owner: 'mod' }
    })
    if (!handle) throw new Error('下载管线未启用')

    const endpoint: DownloadEndpoint = {
      id: `direct:${parsedUrl.toString()}`,
      label: '直链',
      url: parsedUrl.toString()
    }
    ctx.emit('download/report', handle.jobId, { note: '下载 Mod 文件' })
    const result = await serialEvent(ctx, 'download/addFiles', {
      jobId: handle.jobId,
      files: [...targets.values()].map(({ instanceName, target }) => ({
        label: `${fileName} → ${instanceName}`,
        url: endpoint.url,
        savePath: target,
        sha1,
        size,
        sources: [endpoint]
      }))
    })
    if (!result) throw new Error('下载管线未启用')
    await serialEvent(ctx, 'download/seal', handle.jobId)
    log.info(
      '已受理 Mod 安装「%s」：%s → %d 个实例，job %s',
      title,
      fileName,
      targets.size,
      handle.jobId
    )
    return { jobId: handle.jobId }
  })
}

export default defineMainPlugin({ name, inject, apply })
