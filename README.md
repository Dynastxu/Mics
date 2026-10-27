# mics

一切皆插件的 Electron 桌面应用骨架：**内核、工作台、主题、命令，全部是插件**。

- 运行时：[Cordis 4](https://github.com/cordiverse/cordis)（服务容器 / 依赖注入 / fiber 生命周期 / effect 自动回收）
- 外壳：Electron `^45.0.0` + electron-vite 6 + Vite 8 + Vue 3.5 + TypeScript 6
- 包管理：pnpm workspace

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

## 目录结构

```
mics/
├─ apps/desktop/            # Electron 外壳（bootstrap + preload + 渲染器 shell）
│  └─ src/main/             # bootstrap：唯一不是插件的代码
├─ packages/
│  ├─ sdk/                  # @mics/sdk：清单/服务/IPC 契约、插件辅助函数
│  └─ plugin-loader/        # @mics/plugin-loader：扫描目录、校验 plugin.json
├─ plugins/
│  ├─ kernel/               # 内核插件（plugins / ipc / commands / storage / permissions 服务）
│  ├─ core-workbench/       # 默认布局、主题、欢迎页（纯渲染端插件）
│  ├─ hello-world/          # 全栈示例：主进程 RPC + Vue 视图 + 命令 + 状态栏
│  └─ plugin-inspector/     # 插件管理面板
├─ scripts/build-plugins.mjs
├─ boot.config.json         # {"kernel": "mics.kernel", "pluginRoots": ["plugins"]}
└─ docs/architecture.md
```

## 一个插件长什么样

```
plugins/my-plugin/
├─ plugin.json              # 声明式清单：id、入口、贡献点、激活事件、权限
└─ src/
   ├─ main.ts               # 主进程 cordis 插件（可选）
   └─ renderer/
      ├─ index.ts           # 渲染进程 cordis 插件（可选）
      └─ MyView.vue
```

`plugin.json` 示例：

```json
{
  "id": "mics.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "dist/main.mjs",
  "renderer": "dist/renderer.mjs",
  "styles": ["dist/style.css"],
  "dependencies": ["mics.kernel"],
  "contributes": {
    "views": [{ "id": "my.view", "title": "我的视图", "region": "main" }],
    "commands": [{ "id": "my.hello", "title": "My: Hello", "category": "My" }]
  }
}
```

主进程插件就是一个 cordis 插件对象，服务通过依赖注入获得：

```ts
import { defineMainPlugin } from '@mics/sdk/main'
import type { Context } from 'cordis'

export default defineMainPlugin({
  name: 'mics.my-plugin',
  inject: ['ipc', 'commands', 'storage'],
  apply(ctx: Context) {
    ctx.storage.set('count', 1)
    ctx.ipc.handle('ping', () => 'pong')
    ctx.commands.register({ id: 'my.hello', handler: () => 'hello' })
  },
})
```

渲染进程插件同理，UI 贡献会随插件 fiber 一起销毁：

```ts
import { defineRendererPlugin } from '@mics/sdk/renderer'
import MyView from './MyView.vue'

export default defineRendererPlugin({
  name: 'mics.my-plugin',
  inject: ['ui', 'ipc'],
  apply(ctx) {
    ctx.ui.registerView('my.view', MyView)
  },
})
```

## 开发流程

- `pnpm dev` 只负责 shell 的 HMR；改动 `plugins/*/src` 后需要重新 `pnpm build:plugins`
  （或另开一个终端跑 `pnpm watch:plugins`）。
- 插件清单里未声明 `activation` 的插件是**懒激活**的：界面先由清单渲染，
  第一次打开视图 / 执行命令时才加载代码。
- `ctx.effect()`、`ctx.ipc.handle()`、`ctx.ui.registerView()` 等注册都绑定在调用方插件
  的 fiber 上，插件禁用或卸载时自动清理；禁用状态会持久化到 `userData/disabled-plugins.json`，
  之后不会被视图/命令/启动事件自动重新激活。

更多设计细节见 [docs/architecture.md](docs/architecture.md)。
