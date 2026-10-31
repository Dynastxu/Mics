import type { ModCategory } from '@mics/sdk'

/**
 * 整合包类型表。
 *
 * Modrinth 的整合包类型就是搜索 facet 里的分类 slug；CurseForge 的整合包
 * 分类 id 与 Mod 分类完全不同，这里暂不维护数字映射——选择类型时
 * CurseForge 不参与本次筛选，由聚合层报「没有结果」，不会返回不匹配的包。
 */
interface ModpackCategoryDefinition {
  id: string
  label: string
  /** Modrinth 的分类 slug */
  modrinth?: string
}

const DEFINITIONS: readonly ModpackCategoryDefinition[] = [
  { id: 'adventure', label: '冒险', modrinth: 'adventure' },
  { id: 'combat', label: '战斗', modrinth: 'combat' },
  { id: 'exploration', label: '探索', modrinth: 'exploration' },
  { id: 'extra-large', label: '大型', modrinth: 'extra-large' },
  { id: 'ftb', label: 'FTB', modrinth: 'ftb' },
  { id: 'hardcore', label: '硬核', modrinth: 'hardcore' },
  { id: 'magic', label: '魔法', modrinth: 'magic' },
  { id: 'multiplayer', label: '多人', modrinth: 'multiplayer' },
  { id: 'optimization', label: '优化', modrinth: 'optimization' },
  { id: 'quests', label: '任务', modrinth: 'quests' },
  { id: 'sci-fi', label: '科幻', modrinth: 'sci-fi' },
  { id: 'skyblock', label: '空岛', modrinth: 'skyblock' },
  { id: 'small', label: '小型', modrinth: 'small' },
  { id: 'technology', label: '科技', modrinth: 'technology' },
  { id: 'vanilla-like', label: '原版风', modrinth: 'vanilla-like' },
]

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]))
const BY_MODRINTH = new Map(
  DEFINITIONS
    .filter((definition) => definition.modrinth)
    .map((definition) => [definition.modrinth!, definition]),
)

/** CurseForge 整合包分类显示名 -> 与 Modrinth 侧一致的中文标签 */
const CURSEFORGE_LABELS: Record<string, string> = {
  'Adventure and RPG': '冒险',
  'Combat / PvP': '战斗',
  'Exploration': '探索',
  'Extra Large': '大型',
  'FTB': 'FTB',
  'Hardcore': '硬核',
  'Magic': '魔法',
  'Multiplayer': '多人',
  'Optimization': '优化',
  'Quests': '任务',
  'Sci-Fi': '科幻',
  'Skyblock': '空岛',
  'Small / Light': '小型',
  'Technology': '科技',
  'Vanilla+': '原版风',
}

export function listModpackCategories(): ModCategory[] {
  return DEFINITIONS.map((definition) => ({ id: definition.id, label: definition.label }))
}

/** 当前类型在 Modrinth 对应的分类 slug；没有映射时返回 null */
export function modpackModrinthCategoryOf(id: string): string | null {
  return BY_ID.get(id)?.modrinth ?? null
}

/** 搜索结果的分类名 -> 页面展示名；Modrinth 给 slug，CurseForge 给英文名 */
export function modpackCategoryLabelOf(value: string): string {
  return CURSEFORGE_LABELS[value] ?? BY_MODRINTH.get(value)?.label ?? value
}
