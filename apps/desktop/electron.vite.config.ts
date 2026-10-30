import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

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
    plugins: [vue(), vueDevTools()],
    // 开发模式下插件视图源码改道 dev server（/@fs/）转换以支持组件跳转：
    //  - server.fs.allow 放行仓库根目录；
    //  - 显式 alias 把 @mics/* 指到源码，确保插件 /@fs/ 模块与宿主解析到同一实例（避免
    //    PLUGIN_CONTEXT_KEY 等符号身份错位），且不被 pre-bundle 出两套。
    server: {
      fs: {
        allow: [resolve(root, '../..')],
      },
    },
    resolve: {
      alias: [
        {
          find: /^@mics\/sdk\/renderer$/,
          replacement: resolve(root, '../../packages/sdk/src/renderer.ts'),
        },
        {
          find: /^@mics\/sdk$/,
          replacement: resolve(root, '../../packages/sdk/src/index.ts'),
        },
        {
          find: /^@mics\/ui$/,
          replacement: resolve(root, '../../packages/ui/src/index.ts'),
        },
      ],
    },
    build: {
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
})