<script setup lang="ts">
import { computed, ref } from 'vue'

interface DatapackItem {
  id: string
  name: string
  author: string
  summary: string
  downloads: string
  versions: string[]
  kind: string
}

const PACKS: DatapackItem[] = [
  {
    id: 'more-recipes',
    name: '更多合成配方',
    author: '配方工坊',
    summary: '让原版材料组合出更多工具、方块与装饰。',
    downloads: '18 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    kind: '合成',
  },
  {
    id: 'biome-expansion',
    name: '生物群系扩展',
    author: '青野',
    summary: '在现有世界上生成新的群系变体与植被。',
    downloads: '12 万',
    versions: ['1.21.4', '1.21.1'],
    kind: '世界',
  },
  {
    id: 'village-improved',
    name: '村庄改良',
    author: '木石',
    summary: '村庄会随时代扩建，并出现新的职业。',
    downloads: '9.6 万',
    versions: ['1.21.1', '1.20.1'],
    kind: '村庄',
  },
  {
    id: 'difficulty-ladder',
    name: '难度阶梯',
    author: '硬核社',
    summary: '按天数为世界逐级提升怪物强度。',
    downloads: '7.2 万',
    versions: ['1.21.4', '1.20.1'],
    kind: '挑战',
  },
  {
    id: 'ruins-remake',
    name: '遗迹重制',
    author: '探洞者',
    summary: '重新布置地牢、矿井与要塞的战利品。',
    downloads: '15 万',
    versions: ['1.21.1', '1.20.1'],
    kind: '遗迹',
  },
  {
    id: 'seasons',
    name: '季节循环',
    author: '四时',
    summary: '昼夜与季节会改变作物、天气与颜色。',
    downloads: '6.8 万',
    versions: ['1.21.4'],
    kind: '环境',
  },
]

const VERSIONS = ['1.21.4', '1.21.1', '1.20.1']

const query = ref('')
const gameVersion = ref('all')
const notice = ref('')

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return PACKS.filter(
    (pack) =>
      (gameVersion.value === 'all' || pack.versions.includes(gameVersion.value)) &&
      (!keyword || `${pack.name} ${pack.author} ${pack.summary}`.toLowerCase().includes(keyword)),
  )
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">数据包</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div class="mics-toolbar">
      <input v-model="query" class="mics-input mics-toolbar__grow" placeholder="搜索数据包" />
      <select v-model="gameVersion" class="mics-select">
        <option value="all">全部版本</option>
        <option v-for="version in VERSIONS" :key="version" :value="version">{{ version }}</option>
      </select>
    </div>

    <section class="mics-section">
      <h2 class="mics-section__title">结果 · {{ visible.length }}</h2>

      <div v-if="visible.length" class="mics-grid">
        <article v-for="pack in visible" :key="pack.id" class="mics-card">
          <div class="mics-card__head">
            <span class="mics-card__title">{{ pack.name }}</span>
            <span class="mics-badge">{{ pack.kind }}</span>
          </div>
          <p class="mics-card__text">{{ pack.summary }}</p>
          <div class="mics-card__foot">
            <span class="mics-card__meta">
              {{ pack.author }} · {{ pack.versions[0] }} · 下载 {{ pack.downloads }}
            </span>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              @click="notice = `「${pack.name}」的安装流程尚未接入。`"
            >
              安装
            </button>
          </div>
        </article>
      </div>
      <div v-else class="mics-empty">没有匹配的数据包</div>
    </section>
  </div>
</template>
