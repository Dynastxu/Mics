<script setup lang="ts">
import { computed, ref } from 'vue'

interface ModItem {
  id: string
  name: string
  author: string
  summary: string
  downloads: string
  versions: string[]
  loaders: string[]
}

const MODS: ModItem[] = [
  {
    id: 'performance-core',
    name: '性能优化核心',
    author: 'Mics Lab',
    summary: '替换地形与实体的渲染路径，低配机器也能稳住高帧率。',
    downloads: '128 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    loaders: ['Fabric', 'NeoForge'],
  },
  {
    id: 'item-manager',
    name: '物品管理器',
    author: '澄空',
    summary: '整理箱子与背包，支持搜索、自动堆叠与一键补货。',
    downloads: '86 万',
    versions: ['1.21.4', '1.20.1'],
    loaders: ['Fabric', 'Forge'],
  },
  {
    id: 'minimap',
    name: '小地图',
    author: 'Atlas',
    summary: '在角落显示地形、生物与路径点，可导出为图片。',
    downloads: '152 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    loaders: ['Fabric', 'Forge', 'NeoForge'],
  },
  {
    id: 'blueprint',
    name: '建筑蓝图',
    author: '木鱼',
    summary: '导入投影并按材料清单准备方块，适合大型工程。',
    downloads: '41 万',
    versions: ['1.21.1', '1.20.1'],
    loaders: ['Fabric'],
  },
  {
    id: 'crop-overlay',
    name: '作物生长提示',
    author: '稻香',
    summary: '显示作物成熟度、骨粉效果与最佳光照。',
    downloads: '23 万',
    versions: ['1.21.4', '1.20.1'],
    loaders: ['Fabric', 'Forge'],
  },
  {
    id: 'enchant-description',
    name: '附魔描述',
    author: '墨白',
    summary: '在提示框里展开每条附魔的实际效果与冲突关系。',
    downloads: '64 万',
    versions: ['1.21.4', '1.21.1'],
    loaders: ['Fabric', 'NeoForge'],
  },
]

const VERSIONS = ['1.21.4', '1.21.1', '1.20.1']
const LOADERS = ['Fabric', 'Forge', 'NeoForge']

const query = ref('')
const gameVersion = ref('all')
const loader = ref('all')
const notice = ref('')

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return MODS.filter(
    (mod) =>
      (gameVersion.value === 'all' || mod.versions.includes(gameVersion.value)) &&
      (loader.value === 'all' || mod.loaders.includes(loader.value)) &&
      (!keyword || `${mod.name} ${mod.author} ${mod.summary}`.toLowerCase().includes(keyword)),
  )
})

function loaderLabel(mod: ModItem): string {
  const [first, ...rest] = mod.loaders
  return rest.length ? `${first} +${rest.length}` : (first ?? '')
}
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">Mod</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div class="mics-toolbar">
      <input v-model="query" class="mics-input mics-toolbar__grow" placeholder="搜索 Mod" />
      <select v-model="gameVersion" class="mics-select">
        <option value="all">全部版本</option>
        <option v-for="version in VERSIONS" :key="version" :value="version">{{ version }}</option>
      </select>
      <select v-model="loader" class="mics-select">
        <option value="all">全部加载器</option>
        <option v-for="item in LOADERS" :key="item" :value="item">{{ item }}</option>
      </select>
    </div>

    <section class="mics-section">
      <h2 class="mics-section__title">结果 · {{ visible.length }}</h2>

      <div v-if="visible.length" class="mics-grid">
        <article v-for="mod in visible" :key="mod.id" class="mics-card">
          <div class="mics-card__head">
            <span class="mics-card__title">{{ mod.name }}</span>
            <span class="mics-badge">{{ loaderLabel(mod) }}</span>
          </div>
          <p class="mics-card__text">{{ mod.summary }}</p>
          <div class="mics-card__foot">
            <span class="mics-card__meta">{{ mod.author }} · 下载 {{ mod.downloads }}</span>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              @click="notice = `「${mod.name}」的安装流程尚未接入。`"
            >
              安装
            </button>
          </div>
        </article>
      </div>
      <div v-else class="mics-empty">没有匹配的 Mod</div>
    </section>
  </div>
</template>
