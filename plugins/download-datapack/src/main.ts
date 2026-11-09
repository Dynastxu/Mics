import type { Context } from 'cordis'
import { PACK_KIND_LABELS, serialEvent } from '@mics/sdk'
import type { DownloadEndpoint, PackInstallRequest } from '@mics/sdk'
import { defineMainPlugin, resolvePackTargets, safePackFileName } from '@mics/sdk/main'

export const name = 'mics.download.datapack'
export const inject = ['ipc', 'host']

/**
 * 数据包安装：只把 zip 写进实例的 `saves/<存档>/datapacks/`。
 *
 * 不修改存档的 `level.dat`，玩家在游戏内自行启用；传输归下载管线。
 */
export function apply(ctx: Context): void {
  const log = ctx.logger('mics.download.datapack')

  ctx.ipc.handle<PackInstallRequest>('packs/install', async (request) => {
    const file = request?.file
    if (!file) throw new Error('缺少文件信息')

    let parsedUrl: URL
    try {
      parsedUrl = new URL(typeof file.url === 'string' ? file.url.trim() : '')
    } catch {
      throw new Error('无效的下载地址')
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('下载地址必须使用 HTTP(S)')
    }

    const fileName = safePackFileName(file.fileName, /\.zip$/i)
    if (!fileName) throw new Error('无效的文件名')

    const rawSha1 = typeof file.sha1 === 'string' ? file.sha1.trim().toLowerCase() : ''
    const sha1 = /^[0-9a-f]{40}$/.test(rawSha1) ? rawSha1 : ''
    const size =
      typeof file.size === 'number' && Number.isFinite(file.size) ? Math.max(0, file.size) : 0

    const names = Array.isArray(request?.instanceNames) ? [...new Set(request.instanceNames)] : []
    const { targets, detail } = resolvePackTargets(
      ctx.host.paths.userData,
      'datapack',
      names,
      fileName,
      request?.worldName
    )

    const title =
      typeof request?.title === 'string' && request.title.trim()
        ? request.title.trim().slice(0, 120)
        : fileName

    const handle = await serialEvent(ctx, 'download/create', {
      title,
      detail,
      kind: 'pack',
      autoFinish: true,
      display: { packKind: 'datapack' },
      data: { owner: 'pack' }
    })
    if (!handle) throw new Error('下载管线未启用')

    const endpoint: DownloadEndpoint = {
      id: `direct:${parsedUrl.toString()}`,
      label: '直链',
      url: parsedUrl.toString()
    }
    ctx.emit('download/report', handle.jobId, { note: '下载数据包' })

    await serialEvent(ctx, 'download/addFiles', {
      jobId: handle.jobId,
      files: targets.map((target) => ({
        label: `${fileName} → ${target.instanceName}`,
        url: endpoint.url,
        savePath: target.target,
        sha1,
        size,
        guardDir: target.guardDir,
        sources: [endpoint]
      }))
    })
    await serialEvent(ctx, 'download/seal', handle.jobId)
    log.info(
      '已受理%s安装「%s」：%s → %d 个存档，job %s',
      PACK_KIND_LABELS.datapack,
      title,
      fileName,
      targets.length,
      handle.jobId
    )
    return { jobId: handle.jobId }
  })
}

export default defineMainPlugin({ name, inject, apply })
