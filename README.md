# mics

Minecraft Integrated Control Software 的桌面 UI 骨架：**左侧导航、每个页面、主题与布局，全部来自插件**。

- 运行时：[Cordis 4](https://github.com/cordiverse/cordis)（服务容器 / 依赖注入 / fiber 生命周期 / effect 自动回收）
- 外壳：Electron `^45.0.0` + electron-vite 6 + Vite 8 + Vue 3.5 + TypeScript 6
- 包管理：pnpm workspace

当前阶段账户（离线可用；正版设备码暂时借用官方 Live id，见下文 TODO）与启动已经可用；下载管线支持原版 / 加载器安装、Mod 多实例安装与整合包安装。
账户与启动之间的契约是 `auth.credentials` 能力：启动页只消费凭据，不关心登录方式。

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
├─ 账户                    mics.account
├─ 启动                    mics.launch（依赖 mics.account）
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
   ├─ 下载设置               mics.download
   └─ 日志设置               mics.logger
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
│  ├─ java/                 # @mics/java：本机 Java 运行时探测（启动 / 加载器安装器共用）
│  └─ plugin-loader/        # @mics/plugin-loader：扫描目录、校验 plugin.json
├─ plugins/
│  ├─ kernel/               # 内核插件（plugins / ipc / commands / storage / permissions / capabilities 服务）
│  ├─ shell/                # 进程能力：shell.execute 的本机 provider（启动页与其它插件都经它起进程）
│  ├─ account/              # 账户：Microsoft 设备码登录 / 离线账户，提供 auth.credentials 能力
│  ├─ core-workbench/       # 默认导航宽度与主题（纯清单插件，没有代码）
│  ├─ launch/               # 启动页 + 启动设置（依赖账户插件，按凭据启动）
│  ├─ download/             # 下载分组 + 下载设置
│  ├─ download-vanilla/     # 原版版本列表
│  ├─ download-mod/         # Mod 目录（Modrinth / CurseForge，可多实例安装）
│  ├─ download-modpack/     # 整合包目录
│  ├─ download-datapack/    # 数据包目录
│  ├─ download-resourcepack/# 资源包目录
│  ├─ download-shader/      # 光影包目录
│  ├─ notifications/        # 右下角通知服务（ctx.notifications + toast 宿主）
│  ├─ settings/             # 设置分组 + 通用设置页
│  ├─ plugin-inspector/     # 插件管理页（安装 / 启用 / 禁用 / 重载 / 卸载）
│  └─ logger/               # 按启动分文件的日志服务 + 日志设置
├─ examples/
│  └─ hello-tool/           # 验收用示例插件：页面 + 主进程 RPC + 文件读写 + 设置项 + 卸载脚本
├─ scripts/build-plugins.mjs
├─ boot.config.json         # {"kernel": "mics.kernel", "pluginRoots": ["plugins"]}
└─ docs/
   ├─ architecture.md
   └─ plugin-manager.md     # 安装 / 卸载 / 三态 / 内置保护 / 卸载脚本
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

## 账户与启动

账户页在导航最上方，是启动操作的前置条件；启动插件在清单里声明 `mics.account` 依赖：

- **正版**：设备码登录（自动打开浏览器并显示验证码），本地只保存 refresh token，每次启动重新换取
  Minecraft 令牌；令牌失效时账户页会提示「需要重新登录」。
- **离线**：只保存玩家名与离线 UUID，启动时 `user_type=legacy`、令牌为 `0`。
- **不提供第三方（Yggdrasil / authlib-injector）**：这类服务器的端点实现与错误格式并不统一，
  后续作为账户插件里的另一个 provider 再加，启动管线与页面不用改。

启动页消费的是能力而不是账户实现（`@mics/sdk` 的 `AUTH_CREDENTIALS`）：

```ts
interface AuthCredentialsCapability {
  resolve(accountId?: string): Promise<LaunchCredentials>
}

interface LaunchCredentials {
  name: string
  uuid: string
  accessToken: string
  userType: 'legacy' | 'mojang' | 'msa'
  jvmArgs?: string[]
}
```

部署参数在账户插件的 `contributes.configuration`（插件管理 → 账户）的 `microsoftClientId`：

- **当前默认值是临时占位**：官方启动器的 Live 应用 id（`00000000402b5328`），授权页会显示
  Minecraft Launcher，只用于注册完成前联调；代码里标了 `TODO(account)`。
- 正式发布前注册名为 `Mics` 的 Azure 应用，把 client id 替换成它的 GUID：
  1. Azure Portal → 应用注册 → 新注册：名称 `Mics`，账户类型选「仅个人 Microsoft 账户」；
  2. 身份验证 → 高级设置 → 允许公共客户端流（设备代码流程）；
  3. 把「应用程序（客户端）ID」填到 插件管理 → 账户 → Microsoft 应用 client id。
- client id 不是密钥，可以随源码分发；设备码流程不需要 client secret。
- 填的是 GUID 时自动切到 Entra 端点，数字串则使用 Live 端点，不需要额外开关。
- 清空该设置后正版登录不可用，账户页会提示先填 client id。

## 下载、Mod 与整合包

- 原版页负责游戏版本与加载器的安装；Mod 页从 Modrinth / CurseForge 搜索 Mod，搜索条件包括名称、来源、MC 版本、加载器与类型（使用通用漏斗筛选面板），结果在底部按页翻页，点击卡片进入 Mod 详情。
- 进入 Mod 详情时会把搜索页选中的 MC 版本 / 加载器自动设为详情筛选的初始值；筛选选项仍来自该 Mod 的全部版本，用户随时可以改，不存在被搜索条件锁死的情况。
- 实例 Mod 列表的每一行可点击。优先用 jar 的 SHA1 / CurseForge 指纹精确识别项目，带着 `sourceApi + projectId` 直接打开详情；指纹查不到时才按 mod id / 名称搜索回退。外部导入的 Mod 不依赖下载记录，同样可以识别。点击删除或开关不会触发跳转。
- 指纹识别结果按 `hash` 缓存 6 小时；多个同类型来源时用 `sourceApi` 锁定实际命中的镜像，避免版本查询串源。
- 来源在「设置 → 下载设置 → Mod 下载源」里增删、排序与启停。Modrinth 无需配置；CurseForge 官方接口要求 API Key（按其第三方 API 流程申请，按凭据保管，不要提交到仓库或随客户端分发），未填写时该来源自动跳过并在 Mod 页提示，不会影响 Modrinth。需要给所有用户开箱即用时，可以把来源接口地址改成自建代理、Key 留空；桌面客户端里内置 Key 只能防普通用户，无法真正保密。
- 版本列表是单选列表：点击只选中版本，选中行右侧出现「安装」按钮，点击后才打开实例选择；选中的那一行会列出必装前置（Modrinth / CurseForge 的 required 依赖），点击前置按钮直接打开对应 Mod 的详情。返回时回到原来的 Mod，并恢复当时的筛选、版本搜索词、选中的版本与滚动位置；选中的版本若不在视野内会自动滚回来。
- Mod 详情页左上角有「主页」，跳过前置返回栈直接回到 Mod 搜索；版本列表滚动后右下角出现悬浮的「返回顶部」。
- 选择文件后可以一次把同一个 jar 安装到多个实例：实例列表按文件的游戏版本与加载器标记兼容性，原版实例、安装未完成的实例与不匹配的实例不可选；提交后关闭弹窗并在右下角提示，下载任务在「下载进度」里显示每个实例的进度，可暂停、取消或重试，已存在且 SHA1 一致的文件会直接跳过。
- 实例详情的 Mod 列表：左侧显示 jar 内嵌图标（没有图标也保留空位），右侧是删除按钮与启停开关（`.jar` ↔ `.jar.disabled`）；删除会二次确认，避免误删。
- 整合包页复用同一套目录交互（来源 / MC 版本 / 加载器 / 类型筛选，详情与版本列表）。选择版本后先输入实例名：默认取整合包名，非法字符即时清理，重名由主进程校验，不通过时不能提交。
- 整合包安装支持 Modrinth `.mrpack` 与 CurseForge 整合包 zip：主进程先下载归档、解析 `modrinth.index.json` / `manifest.json`，从清单确定游戏版本与加载器，再走与原版安装相同的下载管线；包内 Mod 与游戏文件进同一个队列，`overrides/` 等覆盖文件在所有任务完成后才合并，避免被下载结果覆盖。Quilt 整合包暂不支持，会在安装前给出明确提示。准备阶段还没有文件级任务，下载页会显示当前步骤：归档、加载器安装器与依赖库等传输都会显示实时速度和已下载字节，解析、解压等无法度量进度的步骤显示不确定态进度条。
- 下载队列会优先启动大文件，减少「最后只剩几个大文件、每个文件一条连接」的长尾；「设置 → 下载设置 → 大文件分段」可以对达到分段阈值的文件启用单文件多 Range 连接（默认自动 4 连接，可关闭），阈值本身也在同一页配置（8–128 MB）。服务端不支持 `Accept-Ranges`、文件大小未知或校验值变化时会自动退回单连接，暂停/继续仍按分段断点恢复。
- 下载页的速度只统计真正走网络的字节：命中下载缓存、复用共享库或跳过已存在的文件时进度会前进，但不会虚增速度。缓存占用与清空按钮在「设置 → 下载设置 → 已用缓存」；传输进行中不允许清空，避免正在写入缓存的整合包归档被删掉。

## 日志

`mics.logger` 是主进程插件，提供 `ctx.logs`；其它插件在清单里声明依赖，再注入即可：

```ts
import { defineMainPlugin } from '@mics/sdk/main'

export const name = 'mics.my-plugin'
export const inject = ['logs']

export default defineMainPlugin({
  name,
  inject,
  apply(ctx) {
    // 作用域自动取调用方插件 id：mics.my-plugin
    ctx.logs.info('开始处理 %s', 'download')

    // 需要固定标签时显式指定
    ctx.logs.scope('download').warn('镜像不可用，回退到官方源')
  },
})
```

- 每次启动创建一个 `<userData>/logs/mics-<时间>.log`；默认保留最近 5 个，
  可在「设置 → 日志设置」中调整（1–50）；
- 正文沿用 cordis 的 `%s` / `%d` / `%o` 占位符，传 `Error` 时记录堆栈；
- 启动、插件扫描 / 激活 / 禁用 / 安装 / 卸载、启动游戏、下载与配置变更都会写 **INFO**；
  启动阶段的日志由 cordis 缓冲区补录，日志插件晚于内核激活也不会丢；
- 渲染进程的日志经 `mics.logger/log/write` 汇总到同一个文件，作用域取调用方插件 id；
- 日志文件保留 debug 级别；开发模式下 info / warn / error 同时打印到控制台；
- 已有 `ctx.logger(...)` 的输出也会写进同一个文件，存量插件不需要改代码；
- `ctx.logs` 是主进程服务；渲染进程插件可调用 `mics.logger` 的 `log/write`（作用域自动取调用方 id），
  或经自己的主进程插件转发；
- `mics.logger` 是必需插件（其它插件可能依赖 `logs` 服务），不可在插件管理里禁用，
  清单里声明 `"dependencies": ["mics.logger"]` 可让内核先激活它。

## 通用组件

下载页里的「筛选按钮 / 筛选面板 / 通用列表」是同一种 UI，抽在 `@mics/ui`：

```ts
import {
  BackToTop,
  CatalogBrowser,
  CatalogCard,
  DataBrowser,
  DataList,
  Dialog,
  FilterButton,
  FilterPanel,
  InstanceInstallDialog,
  InstanceNameField,
  ListPager,
  ToggleSwitch,
} from '@mics/ui'
import type { CatalogVersion, FilterGroup, FilterSelection, ListRow } from '@mics/ui'
```

- `CatalogBrowser`：完整的「搜索项目 → 详情 → 版本列表 → 安装」交互，包含来源筛选、分页、
  返回栈、详情滚动恢复与「返回顶部」；页面只注入 IPC 调用与加载器 / 渠道标签，
  `#version-extra` / `#version-action` / `#card` 插槽用于业务特有内容（例如 Mod 的前置）；
- `CatalogCard`：目录网格卡片（图标 / 作者 / 来源徽标 / 类型 / 下载量）；
- `ListPager`：目录分页条，`page` / `page-count` + `@change`；
- `BackToTop`：右下角悬浮「返回顶部」按钮；
- `Dialog`：Teleport 到 body 的通用模态框，统一遮罩、标题、副标题与 footer 插槽；
- `InstanceNameField`：实例名输入与即时校验，本地规则 + 可选的主进程重名检查，`validate()` 可在提交前再确认；
- `InstanceInstallDialog`：整合包这类「新建实例」的安装弹窗，默认名、重名阻断、版本信息与错误展示都已收口；
- `FilterButton`：漏斗按钮 + 「非默认筛选」小圆点，`v-model:open` 控制面板开关；
- `FilterPanel`：按 `FilterGroup[]` 渲染分组胶囊，`v-model` 的形状是 `Record<string, string[]>`；
  `mode: 'single'` 只取一个值，`multi` 选中多项时要求**同时满足**；组名左侧用实心圆 / 空心正方形
  标出这两种模式，`exclusive` 选项（如「全部」）用于清空这一组；
- `DataList`：纯行渲染（主文本 + 徽标 + 次要文本），`role="button"` 整行进入、
  `role="radio"` 单选并显示勾、`role="static"` 仅展示（操作放 `#actions`）；`#row` 插槽可整行自定义；
- `DataBrowser`：搜索框 + 筛选按钮/面板 + 计数标题 + 列表，内部持有查询与筛选状态。
  调用方只提供 `items: ListRow[]` 与 `@select`；筛选分组用 `FilterGroup[]`，
  排序用 `sort(a, b, selection)`，需要跨页面保留状态时再传 `v-model:query` / `v-model:filter`；
- `ToggleSwitch`：布尔开关，`v-model` 绑定状态。

`ListRow` 的 `tags` 是筛选值（key 与 `FilterGroup.key` 对应）；一行有多值时传数组，
多选组命中要求每个选中值都在数组里。`keywords` 参与默认搜索；
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
  第一次打开页面 / 执行命令时才加载代码；声明 `onStartup` / `*` 且有渲染端的
  服务型插件（例如 `mics.notifications`）会随外壳一起启动。
- 右下角通知：渲染端插件声明 `inject: ['notifications']` 后调用
  `ctx.notifications.show({ title, message, level })`；`mics.notifications`
  随外壳启动，并把通知宿主挂到 `body` 上，不占用导航页。
- `ctx.effect()`、`ctx.ipc.handle()`、`ctx.ui.registerView()` 等注册都绑定在调用方插件
  的 fiber 上，插件禁用或卸载时自动清理；禁用状态会持久化到 `userData/disabled-plugins.json`，
  之后不会被页面/命令/启动事件自动重新激活，其导航、命令与样式也会从界面上移除。
- 第三方插件的安装、启停、重载与卸载都不需要重启应用，详见
  [docs/plugin-manager.md](docs/plugin-manager.md)；验收载体是 `examples/hello-tool`。
- 插件管理页点开插件进入详情页：描述、「依赖 / 被依赖 / 提供 / 贡献」、未满足项与设置；
  同一份诊断经只读 RPC `plugins/diagnostics` 暴露，agent 不需要自己推断依赖关系。
- 插件可以用清单里的 `contributes.configuration` 声明设置；点开插件后在该详情页里
  直接编辑，`ctx.storage` 自动补默认值并校验，agent 通过 `configuration/*` 读写。
  设置项较多、需要自定义界面的插件写 `settingsView` 指向自己的页面，详情里就只给入口。
- `boot.config.json` 的 `profile` 指向 `<userData>/profiles/<name>.json`，可强制启用/禁用
  一批插件并给设置项提供默认值；用户自己的开关保存在 `disabled-plugins.json`。
- 开发模式会做清理审计：插件重载后 `ipcMain` / `window` 监听器 / 定时器 / 视图数量
  如果增长，控制台或日志会打印告警与注册堆栈（渲染端前缀 `[mics.cleanup]`）；
  生产构建不安装审计。
- 事件派发模式（`emit` / `bail` / `waterfall` / `serial` / `parallel`）在
  `packages/sdk/src/contract/events.ts` 里统一声明；开发模式会审计派发点与声明不一致的情况。
- 快捷键：`Ctrl+Shift+P` 命令面板，`Ctrl+B` 显示/隐藏左侧导航。
- 窗口无边框，标题栏由 `apps/desktop/src/renderer/shell/WindowTitleBar.vue` 自绘；
  系统菜单已移除，开发/预览构建下用 `F12` 打开 DevTools、`Ctrl+R` 重载渲染进程。

更多设计细节见 [docs/architecture.md](docs/architecture.md)。

## 致谢与独立性说明

本项目为独立开发项目。除下文所述的设计思路启发外，本项目的源代码、界面设计、资源文件及文档均为独立完成，未复制、修改或衍生自任何第三方启动器项目。

在部分功能的交互流程与产品设计上，本项目曾参考 PCL（Plain Craft Launcher）、HMCL 等公开项目的实现效果作为思路启发。该等参考仅限于一般性的交互与设计思路层面，不涉及对上述项目源代码、资源文件或文档内容的复制或修改。

本项目与上述项目及其作者无官方关联，未获得其认可、背书或技术支持。相关项目官方地址可在其各自仓库或官网查询，仅供对照参考。