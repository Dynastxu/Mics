<script setup lang="ts">
import { ref } from 'vue'

const memory = ref('4096')
const javaPath = ref('')
const width = ref('1280')
const height = ref('720')
const jvmArgs = ref('')
const isolation = ref('instance')
</script>

<template>
  <div class="mics-page">
    <header class="mics-page__header">
      <h1 class="mics-page__title">启动设置</h1>
    </header>

    <div class="mics-form">
      <div class="mics-field">
        <div>
          <div class="mics-field__label">最大内存</div>
          <div class="mics-field__hint">单位 MB，留空由启动器自动分配</div>
        </div>
        <div class="mics-field__control">
          <input v-model="memory" class="mics-input" inputmode="numeric" placeholder="4096" />
        </div>
      </div>

      <div class="mics-field">
        <div>
          <div class="mics-field__label">Java 路径</div>
          <div class="mics-field__hint">留空时按游戏版本自动选择</div>
        </div>
        <div class="mics-field__control">
          <input v-model="javaPath" class="mics-input" placeholder="自动检测" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">游戏窗口</div>
        <div class="mics-field__control">
          <input v-model="width" class="mics-input" inputmode="numeric" />
          <span class="mics-muted">×</span>
          <input v-model="height" class="mics-input" inputmode="numeric" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">JVM 参数</div>
        <div class="mics-field__control">
          <input v-model="jvmArgs" class="mics-input" placeholder="-XX:+UseG1GC" />
        </div>
      </div>

      <div class="mics-field">
        <div class="mics-field__label">版本隔离</div>
        <div class="mics-field__control">
          <select v-model="isolation" class="mics-select">
            <option value="instance">按实例隔离</option>
            <option value="shared">共享 .minecraft</option>
          </select>
        </div>
      </div>
    </div>

    <p class="mics-page__note">设置在骨架阶段只做界面，存储与启动参数生成尚未接入。</p>
  </div>
</template>
