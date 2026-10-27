<script setup lang="ts">
import { computed, ref } from 'vue'

interface ResourcepackItem {
  id: string
  name: string
  author: string
  summary: string
  downloads: string
  versions: string[]
  resolution: string
}

const PACKS: ResourcepackItem[] = [
  {
    id: 'clean-ui',
    name: '清爽界面',
    author: '白露',
    summary: '低饱和的 GUI 与字体，适合长时间游玩。',
    downloads: '22 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    resolution: '16×',
  },
  {
    id: 'realistic-64',
    name: '写实材质 64×',
    author: '石匠',
    summary: '保留原版风格的高分辨率材质。',
    downloads: '48 万',
    versions: ['1.21.4', '1.20.1'],
    resolution: '64×',
  },
  {
    id: 'medieval',
    name: '中世纪纹理',
    author: '城堡',
    summary: '石砖、木材与布料的复古配色。',
    downloads: '31 万',
    versions: ['1.21.1', '1.20.1'],
    resolution: '32×',
  },
  {
    id: 'low-end',
    name: '低配优化',
    author: '轻风',
    summary: '把复杂方块压缩成简单色块，帧数更稳。',
    downloads: '17 万',
    versions: ['1.21.4', '1.21.1'],
    resolution: '16×',
  },
  {
    id: 'minimal-sky',
    name: '极简天空',
    author: '远山',
    summary: '去掉云层噪点，只保留渐变与星点。',
    downloads: '11 万',
    versions: ['1.21.4'],
    resolution: '32×',
  },
  {
    id: 'hand-font',
    name: '手绘字体',
    author: '墨线',
    summary: '重新绘制全部界面文字，更适合小屏。',
    downloads: '8.4 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    resolution: '16×',
  },
]

const VERSIONS = ['1.21.4', '1.21.1', '1.20.1']
const RESOLUTIONS = ['16×', '32×', '64×']

const query = ref('')
const gameVersion = ref('all')
const resolution = ref('all')
const notice = ref('')

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return PACKS.filter(
    (pack) =>
      (gameVersion.value === 'all' || pack.versions.includes(gameVersion.value)) &&
      (resolution.value === 'all' || pack.resolution === resolution.value) &&
      (!keyword || `${pack.name} ${pack.author} ${pack.summary}`.toLowerCase().includes(keyword)),
  )
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">资源包</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div class="mics-toolbar">
      <input v-model="query" class="mics-input mics-toolbar__grow" placeholder="搜索资源包" />
      <select v-model="gameVersion" class="mics-select">
        <option value="all">全部版本</option>
        <option v-for="version in VERSIONS" :key="version" :value="version">{{ version }}</option>
      </select>
      <select v-model="resolution" class="mics-select">
        <option value="all">全部分辨率</option>
        <option v-for="item in RESOLUTIONS" :key="item" :value="item">{{ item }}</option>
      </select>
    </div>

    <section class="mics-section">
      <h2 class="mics-section__title">结果 · {{ visible.length }}</h2>

      <div v-if="visible.length" class="mics-grid">
        <article v-for="pack in visible" :key="pack.id" class="mics-card">
          <div class="mics-card__head">
            <span class="mics-card__title">{{ pack.name }}</span>
            <span class="mics-badge">{{ pack.resolution }}</span>
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
      <div v-else class="mics-empty">没有匹配的资源包</div>
    </section>
  </div>
</template>
