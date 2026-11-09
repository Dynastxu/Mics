#!/usr/bin/env node
/**
 * 版本同步：根 `package.json` 是唯一真相源。
 *
 * 产品版本只写在根 `package.json`（`mics` 这个包），所有私有子包的 `version`
 * 由这个脚本下发：
 *   - `apps/desktop`：Electron 的 `app.getVersion()` 与 electron-builder 读它；
 *   - `packages/*`、`plugins/*`：私有工作区包，保持与产品版本一致，避免锁文件、
 *     日志和安装信息里出现两个版本号。
 *
 * 内置插件的 `plugin.json` 不写版本，运行时由宿主用应用版本注入，所以这里不碰清单。
 *
 *   node scripts/sync-version.mjs          # 写入；内容一致时不落盘
 *   node scripts/sync-version.mjs --check  # 只检查，不一致时退出码 1（CI 用）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkOnly = process.argv.includes('--check')

const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = rootManifest.version
if (typeof version !== 'string' || !version) {
  console.error('[version] 根 package.json 缺少 version')
  process.exitCode = 1
} else {
  const targets = []
  for (const group of ['apps', 'packages', 'plugins']) {
    const dir = path.join(root, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, 'package.json')
      if (existsSync(file)) targets.push(file)
    }
  }

  const stale = []
  for (const file of targets) {
    const raw = readFileSync(file, 'utf8')
    const current = JSON.parse(raw).version
    if (current === version) continue
    stale.push({ file, current })
    if (checkOnly) continue

    // 只替换 version 的值，不重新序列化整个文件，避免无谓的格式 diff
    const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
    if (next === raw) {
      console.warn(`[version] ${path.relative(root, file)}：没有找到 version 字段，跳过`)
      continue
    }
    writeFileSync(file, next)
    console.log(`[version] ${path.relative(root, file)}：${current} → ${version}`)
  }

  // 写入模式由 dev / build 自动调用：已经一致就不输出，避免每次构建刷屏
  if (checkOnly) {
    if (stale.length) {
      for (const { file, current } of stale) {
        console.error(`[version] ${path.relative(root, file)}：${current} ≠ ${version}`)
      }
      console.error('[version] 先跑 pnpm version:sync（版本源：根 package.json）')
      process.exitCode = 1
    } else {
      console.log(`[version] 全部子包 = ${version}`)
    }
  }
}
