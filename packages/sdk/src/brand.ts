/**
 * 应用对外品牌标识。
 *
 * User-Agent、启动器的 launcher_name 这类会出现在第三方日志里的字段都从这里取，
 * 避免各插件各写一份 "Mics"。
 */
export const MICS_BRAND = 'Mics'

/**
 * 统一的对外 User-Agent：品牌 + 应用版本。
 *
 * 部分镜像（例如 BMCLAPI 重定向到的 CERNET 节点）会拒绝没有 User-Agent 的请求；
 * Modrinth 等 API 也按 `name/version` 识别与限流客户端。版本由调用方传入
 * （主进程用 `app.getVersion()`），SDK 因此不依赖 Electron。
 */
export function micsUserAgent(version: string): string {
  const normalized = version.trim()
  return normalized ? `${MICS_BRAND}/${normalized}` : MICS_BRAND
}
