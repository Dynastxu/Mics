#!/usr/bin/env node
/**
 * 带示例插件启动开发环境。
 *
 * 默认只扫描 `plugins/`（内置插件）。这个脚本把 `examples/` 也加进插件根目录，
 * 于是 `demo.hello-tool`、`demo.probe-isolated`、`demo.probe-sandboxed` 会作为
 * 内置插件出现在导航里，方便验证沙箱行为。
 *
 * 用法：pnpm dev:with-examples
 * 想切回默认行为直接用 `pnpm dev`。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const roots = [path.join(root, 'plugins'), path.join(root, 'examples')].join(path.delimiter)

console.log(`[dev] 插件根目录（含示例）：${roots}`)
if (!process.env.MICS_SANDBOX_HINT) {
  console.log('[dev] 提示：沙箱默认关闭。要验证隔离，请在 boot.config.json 里加 "sandbox": "enforce"')
}

const child = spawn('pnpm', ['dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MICS_PLUGIN_ROOTS: roots }
})

child.on('exit', (code) => process.exit(code ?? 0))
