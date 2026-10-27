import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const root = import.meta.dirname

export default defineConfig({
  main: {
    // 工作区内的 @mics/* 包以源码形式被打包进来，其余依赖保持 external
    plugins: [externalizeDepsPlugin({ exclude: ['@mics/sdk', '@mics/plugin-loader'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        output: { format: 'es', entryFileNames: 'index.mjs' },
      },
    },
  },
  preload: {
    // sandbox: true 的 preload 必须是 CJS
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    base: './',
    plugins: [vue()],
    build: {
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
})
