# 插件管理：安装、状态与卸载

本文描述 Mics 的插件生命周期模型：插件从哪来、放在哪、怎么启用、怎么卸载，以及
「卸载时清理插件自己创建的东西」这件事为什么必须由插件自己声明。

## 1. 三种状态，界面只显示两种

| 状态 | 含义 | 文件 | 主进程 | 页面 | 界面 |
| --- | --- | --- | --- | --- | --- |
| **启用** | 正在使用 | 在 | 运行 | 显示 | 显示，开关打开 |
| **禁用** | 已安装但不用 | 在 | 停止 | 隐藏 | 显示，开关关闭 |
| **未安装** | 已卸载 | 不在 | 无 | 无 | **不显示** |

「未安装」是内部状态，不是列表里的一行。插件管理页只列**已安装**的插件，
卸载后直接从列表消失；将来做插件市场时，才在市场页展示「未安装」。

已安装但加载失败的插件单独显示为**失败**（红色徽标 + 错误信息），可以重载或修复后重试。

目录本身是「已安装」的唯一事实来源：

```
<应用目录>/resources/plugins/<id>/   内置，只读
<用户数据>/plugins/<id>/             第三方，可写
<用户数据>/plugins/.staging/         安装暂存目录（以 . 开头，扫描时跳过）
<用户数据>/disabled-plugins.json     禁用状态
<用户数据>/plugin-storage/<id>.json  插件自己的设置/状态
```

启动时扫描两个根目录，内置在前、第三方在后，按 id 合并；**第三方不能覆盖内置 id**。

> 「用户数据」在 Windows 上通常位于 `%APPDATA%\Mics\`（`productName` 决定目录名）；
> 开发态与安装后写入的是同一个目录，所以卸载后重启不会把插件「变回来」。

## 2. 内置与第三方

| | 内置 | 第三方 |
| --- | --- | --- |
| 目录 | 应用安装目录 | 用户数据目录 |
| 来源标记 | `source: 'builtin'` | `source: 'user'` |
| 卸载 | **不可**（界面没有按钮，宿主也拒绝） | 可以 |
| 禁用 | 可以 | 可以 |
| 升级 | 跟随应用版本 | 重新安装同一 id 即升级 |

`core` / `essential` 标记的插件（内核、插件管理、日志等）**连禁用也不行**：
禁用开关在界面上锁住，宿主层也会拒绝，避免用户把自己锁在门外。

## 3. 安装

第一版只支持**选文件夹**（zip 是第二版）。安装流程：

```
用户选文件夹
  → 读 plugin.json，校验 id / 版本 / 入口 / 路径
  → 展示来源、能力、权限与风险，用户确认
  → 复制到 <用户数据>/plugins/.staging/<id>.<时间戳>
  → 在暂存目录里再校验一次
  → 同 id 已安装时把旧目录挪到 .staging，再原子 rename 新目录到位
  → 扫描重建插件表，状态为「已禁用」
  → 用户点启用 → 挂载主进程 + 加载页面
```

校验内容：

- `plugin.json` 合法（id 命名空间、semver 版本）；
- 声明的 `main` / `renderer` / `styles` / `uninstall` 入口存在，且在插件目录内（不允许 `..` 越界）；
- id 不占用内置插件 id；
- 复制时展开符号链接（`dereference`），装进去的是文件而不是指向外部的链接。

**安装与启用是分开的**：安装只负责「文件到位、登记」，装完一律禁用。这样用户拖一个
插件进来，不会立刻执行陌生代码。升级同一 id 时先停旧版、替换目录，装完同样保持禁用。

安装失败（校验不过、复制失败、rename 失败）会清掉暂存目录；替换失败时把旧版本放回原位，
已装插件不会因为一次失败的升级而丢失。

## 4. 卸载

卸载由宿主执行，插件本体由宿主彻底删除：

```
确认
  → 停用插件（渲染端先卸页面与样式，主进程 dispose fiber，带超时）
  → 执行卸载脚本（如果有），超时 10 秒
  → 删除插件目录
  → 删除 plugin-storage/<id>.json、禁用记录、协议映射
  → 重新扫描，插件从列表消失
```

内置插件在第一步之前就被拒绝（宿主层检查 `source`，界面也不显示按钮）。

### 4.1 为什么需要「卸载脚本」

插件替用户下载/创建的内容（游戏实例、文件、缓存目录）宿主无法知道在哪，
所以清理必须由插件声明：

```json
{
  "id": "demo.hello-tool",
  "main": "dist/main.mjs",
  "uninstall": "dist/uninstall.mjs"
}
```

- 只有带 `main` 的插件可以声明 `uninstall` —— 页面插件没有主进程，没有执行清理的权限；
- 脚本在插件**停止之后、删除目录之前**执行，默认导出一个函数：

```ts
import type { UninstallScriptContext } from '@mics/plugin-loader'

export default async function uninstall(context: UninstallScriptContext): Promise<void> {
  // context.id / context.dir / context.storage / context.storageFile / context.log
  await rm(path.join(app.getPath('userData'), 'hello-tool'), { recursive: true, force: true })
}
```

- 没有声明脚本的插件，宿主只删本体，插件在目录外留下的东西**保留**；
- 卸载脚本与插件本体权限相同（都是主进程代码）。安装时用户已经确认过信任，卸载时不再额外提权。

### 4.2 脚本失败怎么办

| 失败点 | 处理 | 界面可做的 |
| --- | --- | --- |
| 脚本抛错 / 超时（10s） | **中止卸载**，插件保持「已禁用」，目录保留 | 重试 / **强制卸载**（跳过清理，只删本体） |
| 删除目录失败 | 同上，插件保持「已禁用」 | 重试（需要先解决文件占用） |

卸载失败时插件状态一定是「已禁用」且已写入 `disabled-plugins.json`：它不会在下次启动时
自己跑起来，用户也有机会重试或强制删除。这样既不会被一个坏脚本卡死，也不会悄悄留下孤儿数据。

## 5. 热更新：一个事务

热重载和热插拔是同一件事——**不重启，让插件变化生效**：

```
停掉旧插件
  → 改文件（安装 / 覆盖 / 删除）
  → 装上新插件（如果有）
  → 刷新界面和状态
```

| 操作 | 改文件？ | 说明 |
| --- | --- | --- |
| 安装 | 新增目录 | 装完禁用 |
| 卸载 | 删除目录 | 先停再删 |
| 升级 / 改代码 | 覆盖目录 | 重载即可 |
| 启用 / 禁用 | 不改 | 只切开关 |

第一版不做 HMR：插件是单文件 bundle，卸载再加载就够了。渲染端的 `import()` 带
`?v=<时间戳>` 绕过 ESM 模块缓存，样式链接同样带版本号。

**双进程一致**：主进程 fiber 与页面 fiber 必须一起成功或一起失败。渲染端加载失败时
会回报内核（`plugins/fail`），内核停下主进程并标记失败，不会出现「后台还在跑、页面已经坏了」。

## 6. 运行时分工

| 层 | 负责 | 在哪 |
| --- | --- | --- |
| 三态 / 内置保护 / 安装 / 卸载 / 持久化 | 内核 `PluginsService` | `plugins/kernel/src/services/plugins.ts` |
| 页面与样式卸载、缓存绕过 | 渲染端 `PluginsService` | `apps/desktop/src/renderer/runtime/services/plugins.ts` |
| 选文件夹、确认框、风险提示 | 插件管理页主进程部分 | `plugins/plugin-inspector/src/main.ts` |
| 安装事务（暂存 / 原子替换 / 校验） | `@mics/plugin-loader` | `packages/plugin-loader/src/install.ts` |
| 卸载脚本执行与超时 | `@mics/plugin-loader` | `packages/plugin-loader/src/uninstall.ts` |
| `mics-plugin://` id → 目录映射 | bootstrap | `apps/desktop/src/main/protocol.ts` |
| 清单扫描 / 校验 | `@mics/plugin-loader` | `packages/plugin-loader/src/discovery.ts` |

### 6.1 为什么主进程插件也走 `cordis` shim

第三方主进程插件位于用户数据目录。如果产物里留下 `import { Service } from 'cordis'`，
Node 会从插件目录逐层向上找 `node_modules`，找不到宿主的那份；就算找得到，也会得到
第二个 Cordis 实例，Service / Context 身份不再唯一。

所以构建时把 `cordis` 编译成 shim（`globalThis.__MICS_CORDIS__`），bootstrap 在
import 任何插件之前注入宿主运行时。内置插件与第三方插件因此走同一条路径。

### 6.2 装载层为什么没有直接用 `@cordisjs/plugin-loader`

内核的 `PluginsService` 做的就是 loader 的 `create / update / remove`：每个插件一个
entry、一个 fiber，禁用即 dispose，重载即 remove + create。没有引入官方 loader 的原因
是它会在自己的 entry 上下文里创建 fiber，而 Mics 的 `storage / commands / permissions`
依赖插件作用域上的 `PLUGIN_ID` symbol 来区分「谁在调用」；交给 loader 会丢掉这个身份，
所有插件的存储与命令归属都会退化成内核自己。

如果以后引入官方 loader，需要的是「可注入插件作用域」的 entry 扩展；在那之前，
这里保留等价语义（串行化、超时、失败态）以免重复造轮子之外的部分。

## 7. 验收步骤

构建并启动：

```bash
pnpm build:plugins   # 同时构建 plugins/* 与 examples/*
pnpm dev
```

1. 打开 **设置 → 插件管理**：只列出已安装插件，没有「未安装」行。
2. 内置插件（例如「日志」）没有卸载按钮；普通内置可以禁用；内核 / 插件管理 / 日志的开关是灰的。
3. 点「安装插件」选 `examples/hello-tool` → 确认框显示 id、版本、作者、能力与风险 → 列表出现，
   状态「已禁用」。
4. 打开开关 → 左侧出现「示例插件」页；页面显示页面/后台版本号，能写入并读回 note.txt。
5. 关闭开关 → 页面与导航消失，后台停止；`<userData>/hello-tool/note.txt` 仍在。
6. 点「卸载」并确认 → 执行卸载脚本，`<userData>/hello-tool/` 被删，插件目录与存储被删，列表消失。
7. 把 `uninstall.ts` 改成抛错后重装并卸载 → 中止卸载、插件保持禁用、界面出现「重试 / 强制卸载」。
8. 换一个没有 `uninstall` 的插件卸载 → 只删本体，插件目录外的文件保留。
9. 改插件代码并重载：安装后的插件是 `examples/hello-tool` 的**副本**，所以直接改
   `<用户数据>/plugins/demo.hello-tool/dist/renderer.mjs` 里的 `VERSION`（例如 `0.1.0` → `0.1.1`），
   在插件管理页点「重载」→ 页面数字变化，主进程 PID 不变，导航不重复。
   （改 `examples/hello-tool/src` 后重跑 `pnpm build:plugins` 再重新安装，走的是「升级」路径：
   停旧版 → 替换目录 → 保持禁用 → 手动启用。）
10. 故意把插件代码改坏后重载 → 只有该插件显示失败，其他插件正常；修好后重载恢复。
11. 重启应用 → 已安装插件与启用/禁用状态保留。
12. 连续重载 10 次 → 导航、命令、IPC、样式数量不增长。

## 8. 第一版明确不做

- 插件市场、在线下载、自动更新；
- zip 安装（第二版，会加 `yauzl` / `extract-zip` 与 `semver`）；
- 插件签名与校验和；
- 页面 iframe / 子进程沙箱（目前主进程插件拥有完整 Node 权限，安装时确认即信任）；
- HMR；
- pnpm / npm 运行时安装、多版本共存、自动回滚到上一版。
