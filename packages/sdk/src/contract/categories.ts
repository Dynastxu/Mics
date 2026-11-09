import type { ModCategory } from './mod'

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

const MOD_CATEGORIES: readonly ModCategoryDefinition[] = [
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
  { id: 'bugfix', label: '修复', curseforge: [6821] }
]

const MOD_BY_ID = new Map(MOD_CATEGORIES.map((definition) => [definition.id, definition]))
const MOD_BY_MODRINTH = new Map(
  MOD_CATEGORIES.filter((definition) => definition.modrinth).map((definition) => [
    definition.modrinth!,
    definition
  ])
)

/** 加载器在 Modrinth 搜索里也是分类值；展示标签时要去掉 */
export const MOD_LOADER_CATEGORY_KEYS = new Set(['fabric', 'forge', 'neoforge', 'quilt'])

export function listModCategories(): ModCategory[] {
  return MOD_CATEGORIES.map((definition) => ({ id: definition.id, label: definition.label }))
}

export function isModCategory(id: string): boolean {
  return MOD_BY_ID.has(id)
}

/** 当前类型在 Modrinth 对应的分类 slug；没有映射时返回 null */
export function modrinthCategoryOf(id: string): string | null {
  return MOD_BY_ID.get(id)?.modrinth ?? null
}

/** 当前类型在 CurseForge 对应的分类 id；没有映射时返回空数组 */
export function curseforgeCategoriesOf(id: string): number[] {
  return MOD_BY_ID.get(id)?.curseforge ?? []
}

/** CurseForge 的分类显示名 -> 与 Modrinth 侧一致的中文标签 */
const CURSEFORGE_MOD_LABELS: Record<string, string> = {
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
  'Bug Fixes': '修复'
}

/** Modrinth 搜索结果里的分类 slug -> 页面展示名 */
export function categoryLabelOf(value: string): string {
  return MOD_BY_MODRINTH.get(value)?.label ?? value
}

/** CurseForge 搜索结果的分类名 -> 页面展示名 */
export function curseforgeCategoryLabel(value: string): string {
  return CURSEFORGE_MOD_LABELS[value] ?? value
}

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

const MODPACK_CATEGORIES: readonly ModpackCategoryDefinition[] = [
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
  { id: 'vanilla-like', label: '原版风', modrinth: 'vanilla-like' }
]

const MODPACK_BY_ID = new Map(MODPACK_CATEGORIES.map((definition) => [definition.id, definition]))
const MODPACK_BY_MODRINTH = new Map(
  MODPACK_CATEGORIES.filter((definition) => definition.modrinth).map((definition) => [
    definition.modrinth!,
    definition
  ])
)

/** CurseForge 整合包分类显示名 -> 与 Modrinth 侧一致的中文标签 */
const CURSEFORGE_MODPACK_LABELS: Record<string, string> = {
  'Adventure and RPG': '冒险',
  'Combat / PvP': '战斗',
  Exploration: '探索',
  'Extra Large': '大型',
  FTB: 'FTB',
  Hardcore: '硬核',
  Magic: '魔法',
  Multiplayer: '多人',
  Optimization: '优化',
  Quests: '任务',
  'Sci-Fi': '科幻',
  Skyblock: '空岛',
  'Small / Light': '小型',
  Technology: '科技',
  'Vanilla+': '原版风'
}

export function listModpackCategories(): ModCategory[] {
  return MODPACK_CATEGORIES.map((definition) => ({ id: definition.id, label: definition.label }))
}

/** 当前类型在 Modrinth 对应的分类 slug；没有映射时返回 null */
export function modpackModrinthCategoryOf(id: string): string | null {
  return MODPACK_BY_ID.get(id)?.modrinth ?? null
}

/** 搜索结果的分类名 -> 页面展示名；Modrinth 给 slug，CurseForge 给英文名 */
export function modpackCategoryLabelOf(value: string): string {
  return CURSEFORGE_MODPACK_LABELS[value] ?? MODPACK_BY_MODRINTH.get(value)?.label ?? value
}
