import type { ModCategory } from '@mics/sdk'

/**
 * 跨来源的统一类型表。
 *
 * Modrinth 的类型就是搜索 facet 里的分类名（小写 slug），CurseForge 的类型是
 * 数字分类 id。两边命名并不完全一致（例如「优化」在 Modrinth 叫 optimization、
 * 在 CurseForge 叫 performance），所以统一在这里做映射，页面只看到中文标签。
 *
 * 映射不到某一边时，该来源在这次筛选里不参与：例如「经济」只有 Modrinth 有。
 */

interface ModCategoryDefinition {
  id: string
  label: string
  /** Modrinth 的分类 slug */
  modrinth?: string
  /** CurseForge 的分类 id（classId=6 下的 mc-mods 分类） */
  curseforge?: number[]
}

const DEFINITIONS: readonly ModCategoryDefinition[] = [
  { id: 'optimization', label: '优化', modrinth: 'optimization', curseforge: [6814] },
  { id: 'technology', label: '科技', modrinth: 'technology', curseforge: [412] },
  { id: 'magic', label: '魔法', modrinth: 'magic', curseforge: [419] },
  { id: 'adventure', label: '冒险', modrinth: 'adventure', curseforge: [422] },
  { id: 'decoration', label: '装饰', modrinth: 'decoration', curseforge: [424] },
  { id: 'storage', label: '存储', modrinth: 'storage', curseforge: [420] },
  { id: 'utility', label: '实用', modrinth: 'utility', curseforge: [5191] },
  { id: 'worldgen', label: '世界生成', modrinth: 'worldgen', curseforge: [406] },
  { id: 'mobs', label: '生物', modrinth: 'mobs', curseforge: [411] },
  { id: 'food', label: '食物', modrinth: 'food', curseforge: [436] },
  { id: 'equipment', label: '装备', modrinth: 'equipment', curseforge: [434] },
  { id: 'library', label: '前置库', modrinth: 'library', curseforge: [421] },
  { id: 'redstone', label: '红石', modrinth: 'redstone', curseforge: [4558] },
  { id: 'transportation', label: '交通', modrinth: 'transportation', curseforge: [414] },
  { id: 'economy', label: '经济', modrinth: 'economy' },
  { id: 'minigame', label: '小游戏', modrinth: 'minigame' },
  { id: 'game-mechanics', label: '机制', modrinth: 'game-mechanics' },
  { id: 'bugfix', label: '修复', curseforge: [6821] },
]

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]))
const BY_MODRINTH = new Map(
  DEFINITIONS
    .filter((definition) => definition.modrinth)
    .map((definition) => [definition.modrinth!, definition]),
)

/** 加载器在 Modrinth 搜索里也是分类值；展示标签时要去掉 */
export const MOD_LOADER_CATEGORY_KEYS = new Set(['fabric', 'forge', 'neoforge', 'quilt'])

export function listModCategories(): ModCategory[] {
  return DEFINITIONS.map((definition) => ({ id: definition.id, label: definition.label }))
}

export function isModCategory(id: string): boolean {
  return BY_ID.has(id)
}

/** 当前类型在 Modrinth 对应的分类 slug；没有映射时返回 null */
export function modrinthCategoryOf(id: string): string | null {
  return BY_ID.get(id)?.modrinth ?? null
}

/** 当前类型在 CurseForge 对应的分类 id；没有映射时返回空数组 */
export function curseforgeCategoriesOf(id: string): number[] {
  return BY_ID.get(id)?.curseforge ?? []
}

/** CurseForge 的分类显示名 -> 与 Modrinth 侧一致的中文标签 */
const CURSEFORGE_LABELS: Record<string, string> = {
  Performance: '优化',
  Technology: '科技',
  Magic: '魔法',
  'Adventure and RPG': '冒险',
  Cosmetic: '装饰',
  Storage: '存储',
  'Utility & QoL': '实用',
  'World Gen': '世界生成',
  Mobs: '生物',
  Food: '食物',
  'Armor, Tools, and Weapons': '装备',
  'API and Library': '前置库',
  Redstone: '红石',
  'Player Transport': '交通',
  'Bug Fixes': '修复',
}

/** Modrinth 搜索结果里的分类 slug -> 页面展示名 */
export function categoryLabelOf(value: string): string {
  return BY_MODRINTH.get(value)?.label ?? value
}

/** CurseForge 搜索结果的分类名 -> 页面展示名 */
export function curseforgeCategoryLabel(value: string): string {
  return CURSEFORGE_LABELS[value] ?? value
}
