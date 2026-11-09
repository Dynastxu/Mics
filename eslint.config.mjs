import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.pnpm-store/**',
      '**/out/**',
      'coverage/**',
      '*.local',
      '.agents/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Vue 文件
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        ...globals.browser
      }
    }
  },

  // 浏览器端 TypeScript (renderer)
  {
    files: ['**/renderer/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Node.js 端 TypeScript（主进程、preload、scripts）
  {
    files: [
      '**/main/**/*.ts',
      '**/preload/**/*.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      '*.config.{mjs,js,ts}'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },

  prettierConfig,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn'
    }
  }
)
