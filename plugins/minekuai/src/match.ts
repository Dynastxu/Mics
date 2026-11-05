import type { CatalogDescriptor } from '@mics/sdk'
import type { MineKuaiItem } from './api'

/** 只带需要覆盖的字段；未提供的字段由调用方保留原文 */
export interface CatalogTranslation {
  name?: string
  summary?: string
}

/**
 * 英文必须与来源原文完全一致。
 *
 * 搜索接口是相关度匹配，`Create` 会命中 `Create Deco` 等扩展；因此不能取
 * 第一条，只能逐条比较 `title` 与 `description_en`。这里只去掉首尾空白，
 * 不做大小写、标点或相似度归一化——麦块与 Modrinth 的文本同源，要求完全
 * 一致才能在源站改名/改简介后自然回退，而不是继续展示过期译文。
 */
export function matchesExactly(descriptor: CatalogDescriptor, item: MineKuaiItem): boolean {
  return (
    item.title.trim() === descriptor.name.trim() &&
    item.description.trim() === descriptor.summary.trim()
  )
}

function score(descriptor: CatalogDescriptor, item: MineKuaiItem): number {
  let value = 0
  // 麦块的 project_id 就是 Modrinth 项目 id；同文本的候选里优先它
  if (descriptor.projectId && item.projectId === descriptor.projectId) value += 8
  if (descriptor.slug && item.slug === descriptor.slug) value += 4
  if (item.titleZh) value += 2
  if (item.descriptionZh) value += 1
  return value
}

/**
 * 从候选里挑出唯一可用的译文。
 *
 * 必须至少有一个中文字段非空；只有英文匹配但没有译文时返回 null，调用方
 * 继续显示原文。名称和描述可以单独采用：Sodium 这类品牌名常常没有中文名，
 * 但简介有译文。
 */
export function translateFromCandidates(
  descriptor: CatalogDescriptor,
  candidates: MineKuaiItem[]
): CatalogTranslation | null {
  const matched = candidates.filter(
    (item) =>
      (item.translationStatus === '' || item.translationStatus === 'translated') &&
      matchesExactly(descriptor, item)
  )
  if (matched.length === 0) return null
  matched.sort((a, b) => score(descriptor, b) - score(descriptor, a))
  const chosen = matched.find((item) => item.titleZh || item.descriptionZh)
  if (!chosen) return null
  return {
    ...(chosen.titleZh ? { name: chosen.titleZh } : {}),
    ...(chosen.descriptionZh ? { summary: chosen.descriptionZh } : {})
  }
}
