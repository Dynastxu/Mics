<script setup lang="ts">
import { computed, ref } from 'vue'

interface ShaderItem {
  id: string
  name: string
  author: string
  summary: string
  downloads: string
  versions: string[]
  loader: string
}

const SHADERS: ShaderItem[] = [
  {
    id: 'soft-light',
    name: '柔和光影',
    author: 'Lumen',
    summary: '偏暖的色调与柔和阴影，白天观感最舒服。',
    downloads: '36 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    loader: 'Iris',
  },
  {
    id: 'realistic-water',
    name: '写实水面',
    author: 'Tide',
    summary: '实时反射与折射，水面会随天气变化。',
    downloads: '29 万',
    versions: ['1.21.4', '1.20.1'],
    loader: 'Iris',
  },
  {
    id: 'vintage-film',
    name: '复古胶片',
    author: 'Grain',
    summary: '颗粒、暗角与轻微色散，电影感滤镜。',
    downloads: '14 万',
    versions: ['1.21.4', '1.21.1'],
    loader: 'OptiFine',
  },
  {
    id: 'plain-light',
    name: '极简光影',
    author: 'Plain',
    summary: '只做方向光与雾，几乎不增加显卡负担。',
    downloads: '41 万',
    versions: ['1.21.4', '1.21.1', '1.20.1'],
    loader: 'Iris',
  },
  {
    id: 'starlight',
    name: '星光夜景',
    author: 'Nocturne',
    summary: '加强星空与月亮，夜晚有体积光。',
    downloads: '19 万',
    versions: ['1.21.4'],
    loader: 'Iris',
  },
  {
    id: 'rainy',
    name: '雨天增强',
    author: 'Rainy',
    summary: '雨滴、积水与湿滑反光，氛围更沉浸。',
    downloads: '9.7 万',
    versions: ['1.21.1', '1.20.1'],
    loader: 'OptiFine',
  },
]

const VERSIONS = ['1.21.4', '1.21.1', '1.20.1']
const LOADERS = ['Iris', 'OptiFine']

const query = ref('')
const gameVersion = ref('all')
const loader = ref('all')
const notice = ref('')

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return SHADERS.filter(
    (shader) =>
      (gameVersion.value === 'all' || shader.versions.includes(gameVersion.value)) &&
      (loader.value === 'all' || shader.loader === loader.value) &&
      (!keyword ||
        `${shader.name} ${shader.author} ${shader.summary}`.toLowerCase().includes(keyword)),
  )
})
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">光影包</h1>
    </header>

    <p v-if="notice" class="mics-notice">{{ notice }}</p>

    <div class="mics-toolbar">
      <input v-model="query" class="mics-input mics-toolbar__grow" placeholder="搜索光影包" />
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
        <article v-for="shader in visible" :key="shader.id" class="mics-card">
          <div class="mics-card__head">
            <span class="mics-card__title">{{ shader.name }}</span>
            <span class="mics-badge">{{ shader.loader }}</span>
          </div>
          <p class="mics-card__text">{{ shader.summary }}</p>
          <div class="mics-card__foot">
            <span class="mics-card__meta">
              {{ shader.author }} · {{ shader.versions[0] }} · 下载 {{ shader.downloads }}
            </span>
            <button
              class="mics-button mics-button--ghost mics-button--small"
              @click="notice = `「${shader.name}」的安装流程尚未接入。`"
            >
              安装
            </button>
          </div>
        </article>
      </div>
      <div v-else class="mics-empty">没有匹配的光影包</div>
    </section>
  </div>
</template>
