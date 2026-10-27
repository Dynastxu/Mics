<script setup lang="ts">
import { ref } from 'vue'

const source = ref('official')
const concurrency = ref('8')
const cacheDir = ref('')
const cacheLimit = ref('5')
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">下载设置</h1>
    </header>

    <div class="mics-form">
      <div class="mics-field">
        <div class="mics-field__label">下载源</div>
        <div class="mics-field__control">
          <select v-model="source" class="mics-select">
            <option value="official">官方源</option>
            <option value="mirror">镜像源</option>
            <option value="custom">自定义</option>
          </select>
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">最大并发</div>
          <div class="mics-field__hint">同时下载的文件数</div>
        </div>
        <div class="mics-field__control">
          <input v-model="concurrency" class="mics-input" inputmode="numeric" />
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">缓存目录</div>
          <div class="mics-field__hint">留空使用默认目录</div>
        </div>
        <div class="mics-field__control">
          <input v-model="cacheDir" class="mics-input" placeholder="默认目录" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">缓存上限</div>
        <div class="mics-field__control">
          <select v-model="cacheLimit" class="mics-select">
            <option value="2">2 GB</option>
            <option value="5">5 GB</option>
            <option value="10">10 GB</option>
            <option value="0">不限制</option>
          </select>
        </div>
      </div>
    </div>

    <p class="mics-page__note">下载源与缓存策略尚未接入，这里只确定设置页结构。</p>
  </div>
</template>
