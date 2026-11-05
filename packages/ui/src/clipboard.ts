/**
 * 复制文本到系统剪贴板。
 *
 * 优先用 Clipboard API；它要求安全上下文，且可能被权限策略拒绝，失败时退回
 * 临时 textarea + `document.execCommand('copy')`——插件页面在 Electron 里
 * 两种环境都出现过，不能让「复制」在受限时静默失效。
 *
 * 返回值是是否复制成功，调用方据此决定要不要显示「已复制」。
 */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 权限受限或非安全上下文：继续走兜底方案
  }
  return copyWithTextarea(value)
}

function copyWithTextarea(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
