/**
 * CurseForge 文件直链判定。
 *
 * - `downloadUrl: null`：作者关闭了第三方分发，只能手动下载；
 * - 项目 / 文件页面（`curseforge.com`）：少数镜像会把页面地址填进
 *   `downloadUrl`，它返回的是 HTML，不能当文件下载。
 *
 * CDN（`*.forgecdn.net`）与其它镜像域名原样返回。
 */
export function directDownloadUrl(value: string | null | undefined): string | null {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'curseforge.com' || host.endsWith('.curseforge.com')) return null
  } catch {
    return null
  }
  return url
}
