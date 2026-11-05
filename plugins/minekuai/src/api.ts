import { app } from 'electron'
import { micsUserAgent, type ModProjectKind } from '@mics/sdk'
import type { MineKuaiSettings } from './settings'

/**
 * 麦块公共 API 的只读客户端。
 *
 * 端点按目录类型区分；数据包在麦块没有独立端点，仍然走 `mc-mods`。接口返回
 * `items[]`，英文原文在 `title` / `description_en`，中文在 `title_zh` /
 * `description_zh`。这里只做归一化，是否采用译文由 match.ts 决定。
 */

export interface MineKuaiItem {
  projectId: string
  slug: string
  title: string
  titleZh: string
  description: string
  descriptionZh: string
  loaders: string[]
  translationStatus: string
  translationModel: string
  translationAt: string
}

const ENDPOINTS: Record<ModProjectKind, string> = {
  mod: 'mc-mods',
  modpack: 'mc-modpacks',
  resourcepack: 'mc-resourcepacks',
  shader: 'mc-shaders',
  datapack: 'mc-mods'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function loadersOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
}

function normalizeItem(value: unknown): MineKuaiItem | null {
  if (!isRecord(value)) return null
  const title = textOf(value.title)
  if (!title) return null
  const projectId = textOf(value.project_id)
  return {
    projectId,
    slug: textOf(value.slug) || projectId,
    title,
    titleZh: textOf(value.title_zh),
    // 兼容文档里写作 description 的旧响应；当前接口使用 description_en
    description: textOf(value.description_en) || textOf(value.description),
    descriptionZh: textOf(value.description_zh),
    loaders: loadersOf(value.loaders),
    translationStatus: textOf(value.translation_status),
    translationModel: textOf(value.translation_model),
    translationAt: textOf(value.translation_at)
  }
}

/**
 * 按英文名称查询候选条目。
 *
 * `status=translated` 只取已翻译条目；返回的候选仍需逐条做英文精确比对，
 * 因为搜索是前缀/相关度匹配，`Create` 会同时命中 `Create Deco` 等扩展。
 */
export async function queryMineKuai(
  settings: MineKuaiSettings,
  kind: ModProjectKind,
  query: string,
  signal: AbortSignal
): Promise<MineKuaiItem[]> {
  const keyword = query.trim().slice(0, 120)
  if (!keyword) return []
  const url = new URL(`${settings.baseUrl}/panel/public/${ENDPOINTS[kind]}`)
  url.searchParams.set('q', keyword)
  url.searchParams.set('limit', String(settings.maxCandidates))
  url.searchParams.set('status', 'translated')

  const response = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      'User-Agent': micsUserAgent(app.getVersion()),
      accept: 'application/json'
    }
  })
  if (!response.ok) {
    throw new Error(`麦块 API 返回 HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.items)) return []
  return body.items
    .map((item) => normalizeItem(item))
    .filter((item): item is MineKuaiItem => item !== null)
}
