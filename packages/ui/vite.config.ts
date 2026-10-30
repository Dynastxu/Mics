import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'

/** 仓库根目录：demo 需要读取 apps/desktop 里的设计系统样式 */
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  plugins: [vue(), vueDevTools()],
  server: {
    port: 5180,
    fs: { allow: [workspaceRoot] },
  },
})