import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'

/** 仓库根目录：demo 需要读取 apps/desktop 里的设计系统样式 */
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const sdkEntry = fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: [{ find: /^@mics\/sdk$/, replacement: sdkEntry }],
  },
  server: {
    port: 5180,
    fs: { allow: [workspaceRoot] },
  },
})