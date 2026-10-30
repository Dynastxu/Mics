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

列表每行是「名称 + 徽章 + `id · 版本`」：徽章标注来源（内置 / 第三方）与形态
（页面 / 后台 / 清单），启用状态不再写成文字，只由行尾的开关表示。筛选面板里
**状态**是单选（一个插件只有一个状态），**形态**是多选且按「同时满足」合并：
只勾「页面」会列出所有带页面的插件，勾上「页面」和「后台」则只剩两者都有的插件。

已安装但加载失败的插件单独显示为**失败**（红色徽标 + 错误信息），可以重载或修复后重试。
还有一种运行期状态**等待依赖**：插件已启用，但它 `inject` 的服务没人提供，fiber 停在
pending（代码没有执行）。它不是安装状态，界面只在插件管理里标出来，缺哪些服务写在
`waitingFor` 里；把依赖的服务插件启用后会自动变成「已启用」。

失败会带上 `stage`，因为不同阶段的可恢复动作不同：

| stage | 含义 | 界面给的恢复动作 |
| --- | --- | --- |
| `manifest` | 清单非法 / 入口缺失 | 修正 `plugin.json` 或重新安装 |
| `import` | 主进程或页面入口导入失败 | 重新构建后「重载」 |
| `apply` | cordis 插件启动时抛错 | 修代码后「重载」 |
| `dependency` | 清单依赖或 `inject` 服务未满足 | 「查看依赖」并启用依赖插件后重载 |
| `timeout` | 停止超时，旧代码可能还在跑 | **只能重启应用**（`restartRequired` 会阻止再次激活/替换文件） |
| `renderer` | 渲染端加载失败 | 修页面产物后「重载」 |
| `policy` | 被策略插件拒绝激活 | 查看日志或调整策略 |

`PluginInfo.failure = { stage, message, at }` 是完整诊断；`PluginInfo.error` 保留为
同一条短消息。停止超时的插件会同时带上 `PluginInfo.restartRequired = true`：
内核拒绝再次激活它，也不会在升级时替换它的文件，避免出现「旧 fiber 还在跑、
新 fiber 又挂上去」的双实例。清单扫描阶段就失败的目录（插件进不了列表）不会消失，
而是进入 `plugins/diagnostics` 的 `scanIssues`，插件管理页会显示「N 个插件目录无法加载」。

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
| 清单扫描 / 校验（含配置 schema） | `@mics/plugin-loader` | `packages/plugin-loader/src/discovery.ts` |
| 配置 schema / 默认值 / 校验 | `StorageService` + `ConfigurationService` | `plugins/kernel/src/services/{storage,configuration}.ts` |
| 配置编辑界面 | 插件管理页的插件详情（`PluginSettingsPanel`）；声明 `settingsView` 的插件跳到自己的页面 | `plugins/plugin-inspector/src/renderer/{InspectorView,PluginSettingsPanel}.vue` |
| profile 读取与启用集合合并 | bootstrap + `PluginsService` | `apps/desktop/src/main/config.ts`、`plugins/kernel/src/services/plugins.ts` |
| dev 清理审计 | 内核 / 渲染端 cleanupAudit | `plugins/kernel/src/cleanupAudit.ts`、`apps/desktop/src/renderer/runtime/cleanupAudit.ts` |

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

## 7. 诊断：依赖图与贡献点

插件管理页点开任一插件后进入它的详情页，显示四栏：

| 栏 | 内容 | 数据来源 |
| --- | --- | --- |
| 依赖 | 清单依赖、非内核服务提供方、能力提供方 | `manifest.dependencies` + `fiber.inject` + `capabilities` |
| 被依赖 | 上面那张图的反向边 | 由「依赖」聚合 |
| 提供 | 该插件注册的 cordis 服务与能力（含 provider 标签/优先级） | `fiber.provisions` + `capabilities.providers` |
| 贡献 | RPC、命令、页面、导航分组、状态栏、主题、布局、配置 schema | `IpcService` / `CommandsService` / 清单贡献点 |

底部「未满足」列出这个插件当前拿不到的服务、能力或插件。失败行按 `stage` 显示
不同按钮：`dependency` → 「查看依赖」，`manifest` → 「重新安装」，
`import` / `apply` / `renderer` / `timeout` → 「重载」，`policy` 只解释原因。

同一份数据通过只读 RPC `plugins/diagnostics` 暴露（`PluginGraphReport`），
插件管理页和 agent 读的是同一份，不需要各自推断：

```ts
const report = await ctx.ipc.invoke('mics.kernel', 'plugins/diagnostics')
// report.nodes[].dependsOn / dependents / provides / contributes
// report.unmet[] / report.scanIssues[]
```

## 8. 配置 schema 与 profile

### 8.1 清单内配置 schema

插件在 `plugin.json` 的 `contributes.configuration` 里声明设置项：

```json
{
  "contributes": {
    "configuration": {
      "title": "日志",
      "properties": {
        "maxFiles": {
          "type": "integer",
          "title": "保留文件数",
          "default": 5,
          "minimum": 1,
          "maximum": 50,
          "unit": "个"
        }
      }
    }
  }
}
```

支持的类型：`string` / `number` / `integer` / `boolean` / `enum`；`enum` 用
`options: [{ value, label }]` 描述可选项。复杂结构（例如下载源数组）继续由插件自己的
设置页处理，不强行塞进 schema。

声明后自动获得三件事：

1. **默认值与校验**：`ctx.storage.get/set` 按 schema 取值。没有用户值时返回
   `profile` 默认或 schema 默认；`set` 写入非法值会直接抛错，不会污染 JSON。
2. **插件详情里直接编辑**：点开插件后，详情页按类型渲染输入框 / 数字框 /
   开关 / 下拉，并支持「恢复默认」。
3. **agent 结构化读写**：内核 RPC `configuration/list`、`configuration/set`、
   `configuration/reset`；返回值是 `PluginConfigurationInfo`，包含每个键的
   `value` 与 `source`（`user` / `profile` / `default` / `unset`）。

需要自定义界面时（日志目录、下载源编辑器等），插件仍然贡献自己的设置页，并在
`contributes.configuration` 里把 `settingsView` 指向该视图 id：插件详情里就只留
「打开设置页」入口，同一项设置只有一个编辑位置。这类页面继续用 `ctx.storage`，
因此共享同一套默认值与校验。

```json
{
  "configuration": {
    "title": "启动",
    "settingsView": "settings.launch",
    "properties": { "maxMemory": { "type": "integer", "default": 4096 } }
  }
}
```

`settingsView` 只是界面约定，不影响 `configuration/list` 的返回：agent 仍然能看到
所有插件的全部配置项。

### 8.2 profile：启用集合适配

`boot.config.json` 增加 `profile` 字段：

```json
{
  "kernel": "mics.kernel",
  "pluginRoots": ["plugins"],
  "profile": "lite"
}
```

对应 `<userData>/profiles/lite.json`：

```json
{
  "enable": ["mics.logger"],
  "disable": ["mics.download.modpack", "mics.download.shader"],
  "settings": {
    "mics.logger": { "maxFiles": 3 },
    "mics.launch": { "maxMemory": 2048 }
  }
}
```

- `enable` / `disable` 覆盖用户开关，`disable` 优先；被 profile 锁住的方向在插件管理页
  显示为灰开关，并提示「profile 强制启用/禁用」。
- `settings` 只对**声明了 schema 的原始类型键**生效，语义是**默认值**：
  用户在设置页保存过的值优先；`plugins/diagnostics` 与配置页会标出来源是 `profile`。
- `userData/disabled-plugins.json` 只保存用户自己的开关，不会被 boot.config 或 profile
  写脏；profile 去掉后，用户原来的选择还在。
- profile 文件缺失或字段非法时只告警并退回空 profile，不会阻塞启动。

## 9. 验收步骤

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
   选中该插件 → 详情里的「设置」直接渲染「笔记文件名」；改成 `memo.txt` 后写入的文件随之改名。
5. 关闭开关 → 页面与导航消失，后台停止；`<userData>/hello-tool/note.txt` 仍在。
6. 点「卸载」并确认 → 执行卸载脚本，`<userData>/hello-tool/` 被删，插件目录与存储被删，列表消失。
7. 把 `uninstall.ts` 改成抛错后重装并卸载 → 中止卸载、插件保持禁用、界面出现「重试 / 强制卸载」。
8. 换一个没有 `uninstall` 的插件卸载 → 只删本体，插件目录外的文件保留。
9. 改插件代码并重载：安装后的插件是 `examples/hello-tool` 的**副本**，所以直接改
   `<用户数据>/plugins/demo.hello-tool/dist/renderer.mjs` 里的 `VERSION`（例如 `0.1.0` → `0.1.1`），
   在插件管理页点「重载」→ 页面数字变化，主进程 PID 不变，导航不重复。
   （改 `examples/hello-tool/src` 后重跑 `pnpm build:plugins` 再重新安装，走的是「升级」路径：
   停旧版 → 替换目录 → 保持禁用 → 手动启用。）
10. 故意把插件代码改坏后重载 → 只有该插件显示失败，行内徽标显示失败阶段（导入 / 启动 / 页面）；
    修好后重载恢复。
11. 重启应用 → 已安装插件与启用/禁用状态保留。
12. 连续重载 10 次 → 导航、命令、IPC、样式数量不增长。
13. 点开一个插件 → 列表换成该插件的详情页，四栏显示「依赖 / 被依赖 / 提供 / 贡献」；
    右上角「返回列表」回到列表。点开 `mics.logger` 能看到「提供」里有 `logs` 服务，
    依赖它的插件出现在「被依赖」。
14. 调用 `plugins/diagnostics` → 返回与界面一致的 `PluginGraphReport`；禁用提供方后
    `unmet` / 依赖方的「未满足」随之出现。
15. 点开 `mics.logger` → 详情里出现「设置」，显示「打开设置页」；点进去改保留数为 10 →
    `plugin-storage/mics.logger.json` 写入 10，重启后仍生效。点开声明了 schema 又没有
    `settingsView` 的插件（可用 `examples/hello-tool` 验证）→ 详情里直接出现表单，
    改值后写入 `plugin-storage/<id>.json`，输入越界值被拒绝并显示错误。
16. 在 `boot.config.json` 写 `"profile": "lite"`，创建 `<userData>/profiles/lite.json`
    禁用某个普通插件、设置 `mics.logger.maxFiles = 3` → 重启后该插件开关灰掉、
    日志默认保留 3；在设置页手动改成 5 后用户值优先。
17. 开发模式连续重载 10 次 → 控制台不应出现 `[mics.cleanup]` 告警；如果故意在插件
    `apply` 里加一个不回收的 `window.addEventListener` / `setInterval`，第二次重载开始
    应打印注册堆栈。
18. 两个渲染端插件注册同一个 `ctx.ui.registerView(id, …)` → 第二个插件激活失败并指出
    已由哪个插件注册；插件上下文里访问 `ctx.bridge` 不可用（通过 `ctx.ipc` 调用主进程）。

## 10. 第一版明确不做

- 插件市场、在线下载、自动更新；
- zip 安装（第二版，会加 `yauzl` / `extract-zip` 与 `semver`）；
- 插件签名与校验和；
- 页面 iframe / 子进程沙箱（当前只做 `bridge` 隔离与注册表归属，完整隔离在 M3；
  主进程插件仍拥有完整 Node 权限，安装时确认即信任）；
- HMR；
- pnpm / npm 运行时安装、多版本共存、自动回滚到上一版。
