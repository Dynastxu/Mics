#!/usr/bin/env node
/**
 * 插件构建脚本。
 *
 * 每个 `plugins/<id>/plugin.json` 会被编译成：
 *   dist/main.mjs      —— 主进程 ESM
 *   dist/renderer.mjs  —— 渲染进程 ESM（vite lib 模式，支持 .vue）
 *   dist/style.css     —— 渲染进程样式（若有）
 *   dist/uninstall.mjs —— 卸载脚本（若清单声明了 uninstall）
 *
 * vue / cordis 在两侧都被替换成 shim：插件不打包框架，而是复用宿主注入到
 * globalThis 上的同一份运行时。这样插件放在应用目录还是用户数据目录都一样能跑。
 *
 * `examples/*` 用同一套流程构建，但**不会**被当作内置插件扫描——它们是给
 * 「从文件夹安装」验收用的示例包。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as viteBuild } from 'vite'
import vuePlugin from '@vitejs/plugin-vue'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsDir = path.join(root, 'plugins')
const examplesDir = path.join(root, 'examples')
const sdkDir = path.join(root, 'packages', 'sdk', 'src')
const loaderDir = path.join(root, 'packages', 'plugin-loader', 'src')
const uiEntry = path.join(root, 'packages', 'ui', 'src', 'index.ts')
const shimDir = path.join(root, 'node_modules', '.mics')
const watch = process.argv.includes('--watch')

const SDK_ENTRIES = new Map([
  ['@mics/sdk', path.join(sdkDir, 'index.ts')],
  ['@mics/sdk/main', path.join(sdkDir, 'main.ts')],
  ['@mics/sdk/renderer', path.join(sdkDir, 'renderer.ts')],
])

function resolveSdkSpecifier(specifier) {
  const direct = SDK_ENTRIES.get(specifier)
  if (direct) return direct
  const contractPrefix = '@mics/sdk/contract/'
  if (specifier.startsWith(contractPrefix)) {
    return path.join(sdkDir, 'contract', `${specifier.slice(contractPrefix.length)}.ts`)
  }
  return undefined
}

/* esbuild 侧的解析插件已不再需要：主进程入口同样交给 Vite（SSR 模式）编译 */

function makeViteAliases() {
  const alias = [
    { find: /^@mics\/plugin-loader$/, replacement: path.join(loaderDir, 'index.ts') },
    { find: /^@mics\/ui$/, replacement: uiEntry },
    { find: /^vue$/, replacement: path.join(shimDir, 'vue-shim.js') },
    { find: /^cordis$/, replacement: path.join(shimDir, 'cordis-shim.js') },
  ]
  for (const [specifier, file] of SDK_ENTRIES) {
    alias.push({ find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: file })
  }
  alias.push({
    find: /^@mics\/sdk\/contract\/(.*)$/,
    replacement: path.join(sdkDir, 'contract', '$1.ts'),
  })
  return alias
}

function generateShim(globalName, label, module) {
  const names = Object.keys(module).filter(
    (name) =>
      name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name) && module[name] !== undefined,
  )
  const lines = [
    `// 由 scripts/build-plugins.mjs 生成：插件复用 shell 的 ${label} 运行时`,
    `const runtime = globalThis.${globalName}`,
    'if (!runtime) {',
    `  throw new Error('[mics] ${label} 运行时缺失：${globalName} 未注入（插件必须经 shell 加载）')`,
    '}',
    ...names.map((name) => `export const ${name} = runtime.${name}`),
    '',
    'export default runtime',
    '',
  ]
  return lines.join('\n')
}

async function writeShims() {
  await mkdir(shimDir, { recursive: true })
  const vue = await import('vue')
  const cordis = await import('cordis')
  await writeFile(path.join(shimDir, 'vue-shim.js'), generateShim('__MICS_VUE__', 'Vue', vue))
  await writeFile(
    path.join(shimDir, 'cordis-shim.js'),
    generateShim('__MICS_CORDIS__', 'Cordis', cordis),
  )
}

async function readManifest(dir) {
  const file = path.join(dir, 'plugin.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    console.warn(`[plugins] ${file} 解析失败：${error.message}`)
    return undefined
  }
}

/** 主进程侧入口（main / uninstall）共用一次 SSR 构建 */
async function buildMainEntry(dir, entry, fileName, watchMode) {
  await viteBuild({
    configFile: false,
    root: dir,
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: makeViteAliases() },
    // 插件产物要能脱离仓库 node_modules 运行（插件目录会被单独分发），
    // 因此把运行时依赖打进 dist，而不是留下裸模块导入
    ssr: { noExternal: ['node-downloader-helper'] },
    build: {
      ssr: entry,
      outDir: path.join(dir, 'dist'),
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: true,
      watch: watchMode ? {} : null,
      rollupOptions: {
        // 只留 electron（Electron 内建模块）；cordis 走 shim，必须打进产物，
        // 否则外部插件会按自己的目录去找 node_modules 并直接报模块找不到
        external: ['electron'],
        output: { format: 'es', entryFileNames: fileName },
      },
    },
  })
}

async function buildMain(dir, manifest, watchMode) {
  const entry = path.join(dir, 'src/main.ts')
  if (!existsSync(entry)) {
    if (manifest.main) console.warn(`[plugins] ${manifest.id}: 声明了 main 但缺少 src/main.ts`)
    return false
  }
  await buildMainEntry(dir, entry, path.basename(manifest.main ?? 'dist/main.mjs'), watchMode)
  return true
}

async function buildUninstall(dir, manifest, watchMode) {
  const entry = path.join(dir, 'src/uninstall.ts')
  if (!existsSync(entry)) {
    if (manifest.uninstall) {
      console.warn(`[plugins] ${manifest.id}: 声明了 uninstall 但缺少 src/uninstall.ts`)
    }
    return false
  }
  await buildMainEntry(
    dir,
    entry,
    path.basename(manifest.uninstall ?? 'dist/uninstall.mjs'),
    watchMode,
  )
  return true
}

async function buildRenderer(dir, manifest, watchMode) {
  const entry = path.join(dir, 'src/renderer/index.ts')
  if (!existsSync(entry)) {
    if (manifest.renderer) console.warn(`[plugins] ${manifest.id}: 声明了 renderer 但缺少 src/renderer/index.ts`)
    return false
  }
  const fileName = path.basename(manifest.renderer ?? 'dist/renderer.mjs')
  await viteBuild({
    configFile: false,
    root: dir,
    base: './',
    publicDir: false,
    logLevel: 'warn',
    plugins: [vuePlugin()],
    resolve: { alias: makeViteAliases() },
    build: {
      outDir: path.join(dir, 'dist'),
      emptyOutDir: false,
      target: 'chrome140',
      minify: false,
      sourcemap: true,
      watch: watchMode ? {} : null,
      lib: {
        entry,
        formats: ['es'],
        fileName: () => fileName,
        cssFileName: 'style',
      },
    },
  })
  return true
}

function checkDeclaredFiles(dir, manifest) {
  const declared = [manifest.main, manifest.renderer, manifest.uninstall, ...(manifest.styles ?? [])].filter(
    Boolean,
  )
  for (const relative of declared) {
    if (!existsSync(path.join(dir, relative))) {
      console.warn(`[plugins] ${manifest.id}: 清单声明的 ${relative} 不存在`)
    }
  }
}

async function buildDirectory(baseDir, dirName) {
  const dir = path.join(baseDir, dirName)
  const manifest = await readManifest(dir)
  if (!manifest?.id) return false

  if (!watch) await rm(path.join(dir, 'dist'), { recursive: true, force: true })

  const hasMain = await buildMain(dir, manifest, watch)
  const hasUninstall = await buildUninstall(dir, manifest, watch)
  const hasRenderer = await buildRenderer(dir, manifest, watch)
  if (!hasMain && !hasRenderer) return false
  if (!watch) checkDeclaredFiles(dir, manifest)

  const parts = [hasMain ? 'main' : '', hasRenderer ? 'renderer' : '', hasUninstall ? 'uninstall' : '']
    .filter(Boolean)
    .join(' ')
  console.log(`[plugins] ${manifest.id} ✓ ${parts}`)
  return true
}

async function buildTree(baseDir, label) {
  if (!existsSync(baseDir)) return 0
  const dirents = await readdir(baseDir, { withFileTypes: true })
  let built = 0
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    if (await buildDirectory(baseDir, dirent.name)) built += 1
  }
  if (built) console.log(`[plugins] ${label}：${built} 个`)
  return built
}

async function main() {
  await writeShims()

  const plugins = await buildTree(pluginsDir, '内置插件')
  const examples = await buildTree(examplesDir, '示例插件')

  console.log(
    watch
      ? `[plugins] 监听中（${plugins + examples} 个）…`
      : `[plugins] 完成：${plugins} 个插件 + ${examples} 个示例 → out 就绪，可以 pnpm dev`,
  )
  if (watch) await new Promise(() => {})
}

main().catch((error) => {
  console.error('[plugins] 构建失败', error)
  process.exitCode = 1
})
