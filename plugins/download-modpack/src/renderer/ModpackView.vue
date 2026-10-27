<script setup lang="ts">
import { computed, ref } from 'vue'

interface ModpackItem {
  id: string
  name: string
  author: string
  summary: string
  downloads: string
  versions: string[]
  tags: string[]
}

const PACKS: ModpackItem[] = [
  {
    id: 'star-sea',
    name: '星海生存',
    author: '观星者',
    summary: '在群星之间搭建立足点，附完整任务线与飞船玩法。',
    downloads: '39 万',
    versions: ['1.20.1'],
    tags: ['冒险'],
  },
  {
    id: 'mechanical-era',
    name: '机械纪元',
    author: '齿轮',
    summary: '从水力到核聚变，一条完整的自动化产线。',
    downloads: '57 万',
    versions: ['1.20.1'],
    tags: ['科技'],
  },
  {
    id: 'sky-tale',
    name: '空岛物语',
    author: '云隐',
    summary: '从一棵树开始，把空岛扩成一片大陆。',
    downloads: '28 万',
    versions: ['1.21.1'],
    tags: ['空岛'],
  },
  {
    id: 'dungeon-expedition',
    name: '地牢远征',
    author: '石中剑',
    summary: '随机生成的地牢与 Boss，可单人可联机。',
    downloads: '45 万',
    versions: ['1.19.2'],
    tags: ['冒险'],
  },
  {
    id: 'pastoral',
    name: '田园牧歌',
    author: '南风',
    summary: '种田、钓鱼、造小镇的慢节奏整合。',
    downloads: '21 万',
    versions: ['1.21.4'],
    tags: ['休闲'],
  },
  {
    id: 'deep-sea',
    name: '深海秘境',
    author: '潮汐',
    summary: '以海洋与遗迹为核心的探索整合。',
    downloads: '33 万',
    versions: ['1.18.2'],
    tags: ['冒险'],
  },
  {
    id: 'arcane-corridor',
    name: '魔法回廊',
    author: '灰袍',
    summary: '法术、仪式与维度旅行，兼容主线任务。',
    downloads: '26 万',
    versions: ['1.20.1'],
    tags: ['魔法'],
  },
]

const VERSIONS = ['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2']
const TAGS = ['科技', '冒险', '休闲', '空岛', '魔法']

const query = ref('')
const gameVersion = ref('all')
const tag = ref('all')
const notice = ref('')

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return PACKS.filter(
    (pack) =>
      (gameVersion.value === 'all' || pack.versions.includes(gameVersion.value)) &&
      (tag.value === 'all' || pack.tags.includes(tag.value)) &&
      (!keyword || `${pack.name} ${pack.author} ${pack.summary}`.toLowerCase().includes(keyword)),
  )
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">整合包</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div class="mics-toolbar">
      <input v-model="query" class="mics-input mics-toolbar__grow" placeholder="搜索整合包" />
      <select v-model="gameVersion" class="mics-select">
        <option value="all">全部版本</option>
        <option v-for="version in VERSIONS" :key="version" :value="version">{{ version }}</option>
      </select>
      <select v-model="tag" class="mics-select">
        <option value="all">全部玩法</option>
        <option v-for="item in TAGS" :key="item" :value="item">{{ item }}</option>
      </select>
    </div>

    <section class="mics-section">
      <h2 class="mics-section__title">结果 · {{ visible.length }}</h2>

      <div v-if="visible.length" class="mics-grid">
        <article v-for="pack in visible" :key="pack.id" class="mics-card">
          <div class="mics-card__head">
            <span class="mics-card__title">{{ pack.name }}</span>
            <span class="mics-badge">{{ pack.tags[0] }}</span>
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
      <div v-else class="mics-empty">没有匹配的整合包</div>
    </section>
  </div>
</template>
