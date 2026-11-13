# 插件权限与隔离现状

> 分支 `feat/plugin-permissions`。本文只描述**当前实现**，不含计划。

## 1. 一句话

权限声明、校验、展示已经落地；**进程隔离与引擎级限制只在 `sandbox: "on"` 时生效**，
默认关闭。网络目前**没有任何强制**。

两个轴，不要混：

| 轴 | 在哪 | 决定什么 |
| --- | --- | --- |
| `sandbox` | `boot.config.json` | 要不要真的把插件放进子进程（总开关） |
| `trust` | 每个插件的 `plugin.json` | 放进子进程后限制到什么程度 |

## 2. 三个隔离层

| 层 | 谁在这里 | 边界由什么提供 | 能做什么 |
| --- | --- | --- | --- |
| 渲染进程 | 所有 `renderer` 入口 | Chromium 沙箱：`sandbox: true`、`contextIsolation: true`、无 `nodeIntegration` | 不能碰文件/进程；只能经 `mics:rpc` 调主进程。**所有页面插件共享同一 realm 与 `window.mics`**，互相之间没有隔离 |
| 主进程 `full` | 内核、launch、download-manager、mods-store、shell、account、plugin-inspector、close-behavior | 无 | 与宿主同权限；开了沙箱也不会搬走 |
| 子进程 `sandboxed` | logger、minekuai、hello-tool | 进程边界 + Node `--permission` | 文件与子进程由引擎拒绝；网络不受限 |

`trust` 缺省是 `full`（保持历史行为）。新插件应当显式声明。

## 3. 每个插件的权限

| 插件 | 入口 | trust | 说明 |
| --- | --- | --- | --- |
| `mics.kernel` | main | full | 内核本身 |
| `mics.shell` | main | full | `SHELL_EXECUTE` 的提供方，实现是活对象 |
| `mics.download.manager` | main | full | `FILE_TRANSFER` 的提供方；要写实例目录 |
| `mics.mods.store` | main | full | 在 `${userData}/mods` 与实例 `mods/` 之间建硬链接、扫描回收 |
| `mics.launch` | main + renderer | full | 扫 JDK、起 java、读写游戏目录 |
| `mics.account` | main + renderer | full（v1 数组） | `safeStorage` 加解密 |
| `mics.logger` | main + renderer | **sandboxed** | 只写 `${userData}/logs`；日志经 `log/entry` 事件跨进程推过来 |
| `mics.plugin-inspector` | main + renderer | full | 系统对话框、插件文件操作 |
| `mics.close-behavior` | main + renderer | full | 托盘与窗口生命周期 |
| `mics.minekuai` | main | **sandboxed** | 只做 HTTP 查询；无文件访问（默认禁用，需手动启用） |
| `demo.hello-tool` | main + renderer | **sandboxed** | 示例插件，写 `${userData}/hello-tool` |
| `mics.download` 及 6 个 `mics.download.*` | renderer | —（页面插件） | 权限声明对页面插件无意义 |
| `mics.settings` / `mics.notifications` / `mics.core-workbench` | renderer / manifest | — | 同上 |

**默认安装下没有任何插件跑在子进程里**：`sandbox` 默认 `off`；即使改成 `on`，
唯一声明了 `sandboxed` 的内置插件 `mics.minekuai` 是 `defaultDisabled`。

## 4. 权限维度与强制程度

| 维度 | 声明 | 强制手段 | 强度 | 当前状态 |
| --- | --- | --- | --- | --- |
| 读/写目录 | `fs.read` / `fs.write` / `fs.meta` | `--allow-fs-read/write`（**目录前缀**，不支持 `*.jar`） | 引擎级 | `sandbox: on` 且插件是 `sandboxed` 时生效 |
| 能否执行程序 | `exec[]` | `--allow-child-process`（全有全无） | 引擎级 | 同上 |
| 执行哪个程序 | `exec[].bin` / `args` | 无（broker 未实现 exec 路由） | **无** | 未强制 |
| 原生模块 / worker | — | `--permission` 默认禁止 | 引擎级 | 同上 |
| 联网域名 | `net.mode` / `hosts` | 无 | **无** | 子进程可以直接连任何地址 |
| 剪贴板 / 通知 / 对话框 / 外链 | `os.*` | 宿主代做 + 调用点校验 | 软拦 | 仅 `shell.openExternal` 有校验 |
| 能力（capability） | — | 宿主代理：`cap-call`；子进程不能 `provide` | 结构性 | 已生效 |
| 跨进程事件 | — | 只桥接 `plugins/changed`、`catalog/describe`、`log/entry` | 结构性 | 已生效 |
| 存储 | — | 宿主代理，100ms 合并写回 | 结构性 | 已生效 |
| 宿主信息 | — | `ctx.host.paths` / `app` / `shell` | 结构性 | 已生效 |

“结构性”指：子进程里根本没有对应实现，只能经代理；不是策略判断。

## 4.1 网络：只有声明，没有强制

**`net.mode` / `net.hosts` 目前不产生任何行为。** 一个 `sandboxed` 插件即使写了
`"mode": "none"`，也仍然可以直接 `fetch` / `net.connect` / IP 直连 / DoH，
宿主不会拦、也不会记录。

为什么不拦：

- Node 的 `--permission` **不覆盖网络**（只覆盖 fs、子进程、worker、addon）；
- Windows 上按进程断网要么需要管理员（防火墙规则），要么需要内核驱动（WFP），
  要么需要原生启动器（AppContainer 无 `internetClient` 能力）；
- 域名级过滤本质上要求宿主做 MITM 代理（自签证书），消费级产品不可接受。

已确认的前提（探针验证）：`--permission` 挡住了 `child_process`，子进程**起不了
孙子进程**。所以「按 PID 查 TCP/UDP 表」得到的就是这个插件的全部网络，没有
「插件开个头、把活交给子进程」的漏洞。

三条可选路线，成本差一个数量级：

| 层 | 做法 | 成本 | 能挡住 | 挡不住 |
| --- | --- | --- | --- | --- |
| L1 审计 | 每 5 秒按 PID 查连接，违规记 `permission/violation` + 红标 + 可选自动禁用 | 1–2 天 | 什么都不挡，但**看得见** | 一切 |
| L2 软拦 | 宿主提供 `ctx.net.fetch()`，逐跳校验 allowlist；插件拿不到 socket | 3–5 天 | 走 broker 的调用 | 插件自己 `require('node:net')` |
| L3 硬拦 | AppContainer（无 `internetClient`）启动子进程 | 2–3 周 + 原生代码 | **所有**出站连接 | 仍然只有「有/无」，没有域名级 |

结论：**「能不能联网」可以硬拦，但要原生层；「连哪些域名」永远只能是软拦 + 审计。**

现在不做，触发条件是：出现真实的插件乱连事件，或者开始有插件市场。在那之前，
`net` 字段只作为「插件作者意图的说明」，不是承诺。

> 界面上的措辞已经同步：插件详情只说「文件与程序执行由系统强制」，不再暗示网络受限。

## 5. 运行时开关

`boot.config.json`：

```json
{ "sandbox": "off" | "on" }
```

| 值 | 行为 |
| --- | --- |
| `off`（默认） | 所有插件在主进程内挂载，权限只用于展示；回退开关 |
| `on` | 按每个插件的 `trust` 执行（见下表） |

`on` 时各信任级别的行为：

| trust | 位置 | `--permission` | 效果 |
| --- | --- | --- | --- |
| `full` | 主进程 | — | 与宿主同权限 |
| `sandboxed` | 子进程 | ✅ | 清单里的 fs / exec 声明生效 |

> 旧写法 `"audit"` / `"enforce"` 仍可用：都会按 `"on"` 处理并打印一条废弃警告。
> 权限强制不再由全局开关决定——它是 `trust` 的事。

## 6. 宿主代做的部分（不消耗插件权限）

| 能力 | 入口 | 备注 |
| --- | --- | --- |
| 用户数据 / 插件目录 / 临时目录 / home | `ctx.host.paths` | `pluginDir` 按调用方解析 |
| 应用版本 / 是否开发态 | `ctx.host.app` | 替代 `app.getVersion()` / `app.isPackaged` |
| 打开外链 / 在文件管理器定位 | `ctx.host.shell` | `openExternal` 仍检查 `shell:openExternal` |
| IPC 注册 | `ctx.ipc.handle` | 宿主侧转成 RPC 转发器 |
| 存储 | `ctx.storage` | 同步 API，写入合并回传 |
| 能力 | `ctx.capabilities.require` | 宿主代理，见 `capability-broker.md` |

## 7. 未实现（借鉴 `isolated-function` 的部分）

| 项 | 现状 | 计划 |
| --- | --- | --- |
| 启动超时 | `startInWorker` 直接 `await whenReady()`，worker 卡死会挂住激活 | 15s 超时后判失败 |
| 内存上限 | 无 | `--max-old-space-size` + worker 每 2s 上报 `rss`，超预算或心跳丢失即杀进程 |
| 心跳 | 无 | 同上；也是“卡死”检测的基础 |
| 子进程日志归属 | stdout/stderr 转发进 logger，但没打 plugin id | 加上 scope，便于按插件过滤 |
| 网络限制 | 无强制、无审计 | 见下 |

关于内存：`--max-old-space-size` 只限制 V8 堆，`Buffer` / `ArrayBuffer` / WASM 不计入，
所以它挡的是“常规内存泄漏”，不是恶意分配。真正的硬上限要 Job Object（原生层）。

## 8. 与 `isolated-function` 的关系

它验证了同一条路线（子进程 + Node 权限模型 + 默认拒绝），但形态不同：

| | `isolated-function` | MICS 插件 |
| --- | --- | --- |
| 执行形态 | 一次调用 → 一个进程 → 一个返回值 | 长期驻留、事件驱动、持有状态 |
| 依赖 | 运行时静态分析 + `npm install` + 白名单 | 构建期打包进 `dist/main.mjs` |
| 粒度 | 函数 | 插件 |

因此**不引入**它作为运行时，但借鉴它的资源限制思路（见 §7）。
如果将来要支持“用户写一段脚本”（自定义下载规则、过滤表达式），那才是它的主场。

## 9. 怎么验证

- 单元/集成：`packages/plugin-host` 与 `plugins/kernel/src/services/pluginWorkerHost.ts`
  在分支上有一次性的端到端脚本（fork + `--permission` + 真实插件产物），
  覆盖：越界写被拒、事件桥、能力代理。
- 本地：把 `boot.config.json` 的 `sandbox` 改成 `"on"`，启用 `mics.minekuai`，
  或用「从文件夹安装」装上 `examples/hello-tool`；
  要对照隔离级别，用 `pnpm dev:with-examples` 打开两个探针页。
