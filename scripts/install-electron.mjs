#!/usr/bin/env node
/**
 * 安装 Electron 二进制。
 *
 * pnpm（v10+）默认不执行依赖的 postinstall，Electron 的 dist 就不会被下载，
 * 导致 `electron` 命令只能当 Node 用。这个脚本直接调用 electron/install.js，
 * 并强制注入 npmmirror 镜像，避开 GitHub 下载失败。
 *
 *   node scripts/install-electron.mjs          # 已安装则跳过
 *   node scripts/install-electron.mjs --force  # 强制重装
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const appManifest = path.join(root, 'apps', 'desktop', 'package.json')
const requireFromApp = createRequire(appManifest)

let installPath
try {
  installPath = requireFromApp.resolve('electron/install.js')
} catch {
  console.warn('[install-electron] 未找到 electron/install.js，跳过')
  process.exit(0)
}

const electronDir = path.dirname(installPath)
const binary = path.join(
  electronDir,
  'dist',
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron',
)

if (existsSync(binary) && !process.argv.includes('--force')) {
  console.log(`[install-electron] 已存在：${path.relative(root, binary)}`)
  process.exit(0)
}

const version = createRequire(installPath)(path.join(electronDir, 'package.json')).version
console.log(`[install-electron] 开始下载 Electron ${version}（镜像：npmmirror）…`)

const result = spawnSync(process.execPath, [installPath], {
  stdio: 'inherit',
  cwd: electronDir,
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  },
})

if (result.status !== 0) {
  console.error('[install-electron] Electron 二进制安装失败')
  process.exit(result.status ?? 1)
}

if (!existsSync(binary)) {
  console.error(`[install-electron] 安装结束但未找到二进制：${binary}`)
  process.exit(1)
}

console.log('[install-electron] 完成')
