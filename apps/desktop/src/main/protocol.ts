import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginRecord } from '@mics/sdk'
import { PLUGIN_SCHEME } from '@mics/sdk'


const MIME_TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/** 必须在 app ready 之前调用 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/**
 * mics-plugin://<plugin-id>/<path>
 * 把插件目录映射成一个只读的 ESM/CSS 源，渲染进程据此懒加载插件产物。
 */
export function registerPluginProtocol(plugins: PluginRecord[]): void {
  const dirs = new Map(plugins.map((record) => [record.manifest.id, record.dir]))

  protocol.handle(PLUGIN_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const pluginId = decodeURIComponent(url.hostname)
      const dir = dirs.get(pluginId)
      if (!dir) return new Response('unknown plugin', { status: 404 })

      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = path.resolve(dir, relative)
      const normalizedDir = dir.toLowerCase()
      const normalizedTarget = target.toLowerCase()
      if (!normalizedTarget.startsWith(`${normalizedDir}${path.sep}`)) {
        return new Response('forbidden', { status: 403 })
      }

      const data = await readFile(target)
      const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
