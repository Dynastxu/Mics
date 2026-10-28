# mics

Minecraft Integrated Control Software 的桌面 UI 骨架：**左侧导航、每个页面、主题与布局，全部来自插件**。

- 运行时：[Cordis 4](https://github.com/cordiverse/cordis)（服务容器 / 依赖注入 / fiber 生命周期 / effect 自动回收）
- 外壳：Electron `^45.0.0` + electron-vite 6 + Vite 8 + Vue 3.5 + TypeScript 6
- 包管理：pnpm workspace

当前阶段只确定界面与贡献点：安装、启动、账户等操作仍是占位，只有主题、导航和页面内的搜索/筛选是真实交互。

## 快速开始

要求 Node **>= 22.12**、pnpm 12、Electron 45。

```bash
pnpm install        # 安装依赖（会下载 Electron）
pnpm build:plugins  # 把 plugins/* 编译成 dist/main.mjs + dist/renderer.mjs
pnpm dev            # 启动 Electron（开发模式，渲染进程带 HMR）
```

生产构建：

```bash
pnpm build          # 插件 + apps/desktop 一起构建到 apps/desktop/out
pnpm start          # 预览构建结果
```

类型检查：

```bash
pnpm typecheck      # 渲染进程 vue-tsc + 主进程 tsc + 插件 vue-tsc
```

## 界面结构

```
左侧导航
├─ 启动                    mics.launch
├─ 下载                    mics.download（分组）
│  ├─ 原版                 mics.download.vanilla
│  ├─ Mod                  mics.download.mod
│  ├─ 整合包               mics.download.modpack
│  ├─ 数据包               mics.download.datapack
│  ├─ 资源包               mics.download.resourcepack
│  └─ 光影包               mics.download.shader
└─ 设置                    mics.settings（分组）
   ├─ 通用                  mics.settings
   ├─ 插件管理               mics.plugin-inspector
   ├─ 启动设置               mics.launch
   └─ 下载设置               mics.download
```

每一个叶子节点都是一个 `nav` 贡献，对应一个页面。分组本身由 `navGroups` 声明，
子项由各插件独立挂载——新增一个下载分类只需要新增一个插件目录。

窗口是无边框的：顶部标题栏（品牌 + 最小化/最大化/关闭）、左侧导航容器与底部状态栏
都由 shell 绘制，没有系统菜单栏（`Menu.setApplicationMenu(null)`）。

## 目录结构

```
mics/
├─ apps/desktop/            # Electron 外壳（bootstrap + preload + 渲染器 shell）
│  └─ src/main/             # bootstrap：唯一不是插件的代码
├─ packages/
│  ├─ sdk/                  # @mics/sdk：清单/服务/IPC 契约、插件辅助函数
│  ├─ ui/                   # @mics/ui：通用 UI 组件（筛选面板、可搜索列表）
│  └─ plugin-loader/        # @mics/plugin-loader：扫描目录、校验 plugin.json
├─ plugins/
│  ├─ kernel/               # 内核插件（plugins / ipc / commands / storage / permissions 服务）
│  ├─ core-workbench/       # 默认导航宽度与主题（纯清单插件，没有代码）
│  ├─ launch/               # 启动页 + 启动设置（主进程 stub RPC + 渲染页）
│  ├─ download/             # 下载分组 + 下载设置
│  ├─ download-vanilla/     # 原版版本列表
│  ├─ download-mod/         # Mod 目录
│  ├─ download-modpack/     # 整合包目录
│  ├─ download-datapack/    # 数据包目录
│  ├─ download-resourcepack/# 资源包目录
│  ├─ download-shader/      # 光影包目录
│  ├─ settings/             # 设置分组 + 通用设置页
│  └─ plugin-inspector/     # 插件管理页
├─ scripts/build-plugins.mjs
├─ boot.config.json         # {"kernel": "mics.kernel", "pluginRoots": ["plugins"]}
└─ docs/architecture.md
```

## 一个插件长什么样

```
plugins/my-plugin/
├─ plugin.json              # 声明式清单：id、入口、导航项、激活事件、权限
└─ src/
   ├─ main.ts               # 主进程 cordis 插件（可选）
   └─ renderer/
      ├─ index.ts           # 渲染进程 cordis 插件（可选）
      └─ MyView.vue
```

`plugin.json` 示例（给「下载」分组加一个页面）：

```json
{
  "id": "mics.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "renderer": "dist/renderer.mjs",
  "contributes": {
    "nav": [
      { "id": "my.view", "group": "download", "title": "我的分类", "order": 70 }
    ]
  }
}
```

`nav[].id` 同时是页面组件在渲染进程里的注册键：

```ts
import { defineRendererPlugin } from '@mics/sdk/renderer'
import MyView from './MyView.vue'

export const name = 'mics.my-plugin'
export const inject = ['ui']

export default defineRendererPlugin({
  name,
  inject,
  apply(ctx) {
    ctx.ui.registerView('my.view', MyView)
  },
})
```

主进程插件就是一个 cordis 插件对象，服务通过依赖注入获得（`plugins/launch/src/main.ts`）：

```ts
import { defineMainPlugin } from '@mics/sdk/main'

export const name = 'mics.my-plugin'
export const inject = ['ipc']

export default defineMainPlugin({
  name,
  inject,
  apply(ctx) {
    ctx.ipc.handle('ping', () => 'pong')
  },
})
```

页面里用 `usePluginContext()` 拿到所属插件的作用域，再通过 `ctx.ipc.invoke('mics.my-plugin', 'ping')` 调用主进程。

## 通用组件

下载页里的「筛选按钮 / 筛选面板 / 通用列表」是同一种 UI，抽在 `@mics/ui`：

```ts
import { DataBrowser, DataList, FilterButton, FilterPanel, ToggleSwitch } from '@mics/ui'
import type { FilterGroup, FilterSelection, ListRow } from '@mics/ui'
```

- `FilterButton`：漏斗按钮 + 「非默认筛选」小圆点，`v-model:open` 控制面板开关；
- `FilterPanel`：按 `FilterGroup[]` 渲染分组胶囊，`v-model` 的形状是 `Record<string, string[]>`；
  `mode: 'single'` 单选，`multi` 多选，`exclusive` 选项（如「全部」）与其它选项互斥；
- `DataList`：纯行渲染（主文本 + 徽标 + 次要文本），`role="button"` 整行进入、
  `role="radio"` 单选并显示勾、`role="static"` 仅展示（操作放 `#actions`）；`#row` 插槽可整行自定义；
- `DataBrowser`：搜索框 + 筛选按钮/面板 + 计数标题 + 列表，内部持有查询与筛选状态。
  调用方只提供 `items: ListRow[]` 与 `@select`；筛选分组用 `FilterGroup[]`，
  排序用 `sort(a, b, selection)`，需要跨页面保留状态时再传 `v-model:query` / `v-model:filter`；
- `ToggleSwitch`：布尔开关，`v-model` 绑定状态。

`ListRow` 的 `tags` 是筛选值（key 与 `FilterGroup.key` 对应），`keywords` 参与默认搜索；
「排序方式」这类组在 `FilterGroup` 上标记 `affects: 'order'`，值交给 `sort` 读取而不参与行过滤；
`defaultSelection()` / `filterRows()` / `isFilterActive()` 也单独导出，供自定义布局复用。

组件复用 shell 的 `mics-*` 设计系统类，自带的 scoped 样式会进插件的 `dist/style.css`，
因此使用方需要在 `plugin.json` 里声明 `styles`（参考 `plugins/download-vanilla/plugin.json`）。

组件可以脱离 Electron 单独调试：

```
pnpm demo:ui     # → http://localhost:5180
```

demo 在 `packages/ui/demo`，直接复用 shell 的 `main.css`，改 `packages/ui/src` 会热更新；
页面里的开关可以切换搜索框 / 筛选分组 / 空数据，状态栏实时显示 `query` 与 `filter`。

## 开发流程

- `pnpm dev` 只负责 shell 的 HMR；改动 `plugins/*/src` 后需要重新 `pnpm build:plugins`
  （或另开一个终端跑 `pnpm watch:plugins`）。
- 插件清单里未声明 `activation` 的插件是**懒激活**的：导航先由清单渲染，
  第一次打开页面 / 执行命令时才加载代码。
- `ctx.effect()`、`ctx.ipc.handle()`、`ctx.ui.registerView()` 等注册都绑定在调用方插件
  的 fiber 上，插件禁用或卸载时自动清理；禁用状态会持久化到 `userData/disabled-plugins.json`，
  之后不会被页面/命令/启动事件自动重新激活，其导航、命令与样式也会从界面上移除。
- 快捷键：`Ctrl+Shift+P` 命令面板，`Ctrl+B` 显示/隐藏左侧导航。
- 窗口无边框，标题栏由 `apps/desktop/src/renderer/shell/WindowTitleBar.vue` 自绘；
  系统菜单已移除，开发/预览构建下用 `F12` 打开 DevTools、`Ctrl+R` 重载渲染进程。

更多设计细节见 [docs/architecture.md](docs/architecture.md)。
