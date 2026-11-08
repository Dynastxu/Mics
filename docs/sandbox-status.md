# 插件权限与隔离现状

> 分支 `feat/plugin-permissions`。本文只描述**当前实现**，不含计划。

## 1. 一句话

权限声明、校验、展示已经落地；**进程隔离与引擎级限制只在 `sandbox.mode = enforce` 且插件声明
`trust: sandboxed` 时生效**，默认关闭。网络目前**没有任何强制**。

## 2. 四个隔离层

| 层 | 谁在这里 | 边界由什么提供 | 能做什么 |
| --- | --- | --- | --- |
| 渲染进程 | 所有 `renderer` 入口 | Chromium 沙箱：`sandbox: true`、`contextIsolation: true`、无 `nodeIntegration` | 不能碰文件/进程；只能经 `mics:rpc` 调主进程。**所有页面插件共享同一 realm 与 `window.mics`**，互相之间没有隔离 |
| 主进程 `full` | 内核、launch、download-manager、shell、account、logger、plugin-inspector、close-behavior | 无 | 与宿主同权限 |
| 子进程 `isolated` | （当前无人使用） | 进程边界 | 崩溃隔离；**不防越权**（仍可读写任意文件） |
| 子进程 `sandboxed` | hello-tool（示例）、minekuai | 进程边界 + Node `--permission` | 文件与子进程由引擎拒绝；网络不受限 |

`trust` 缺省是 `full`（保持历史行为）。新插件应当显式声明。

## 3. 每个插件的权限

| 插件 | 入口 | trust | 说明 |
| --- | --- | --- | --- |
| `mics.kernel` | main | full | 内核本身 |
| `mics.shell` | main | full | `SHELL_EXECUTE` 的提供方，实现是活对象 |
| `mics.download.manager` | main | full | `FILE_TRANSFER` 的提供方；要写实例目录 |
| `mics.launch` | main + renderer | full | 扫 JDK、起 java、读写游戏目录 |
| `mics.account` | main + renderer | full（v1 数组） | `safeStorage` 加解密 |
| `mics.logger` | main + renderer | full | 观察宿主日志并落盘（已事件化，刻意留在宿主） |
| `mics.plugin-inspector` | main + renderer | full | 系统对话框、插件文件操作 |
| `mics.close-behavior` | main + renderer | full | 托盘与窗口生命周期 |
| `mics.minekuai` | main | **sandboxed** | 只做 HTTP 查询；无文件访问（默认禁用，需手动启用） |
| `demo.hello-tool` | main + renderer | **sandboxed** | 示例插件，写 `${userData}/hello-tool` |
| `mics.download` 及 6 个 `mics.download.*` | renderer | —（页面插件） | 权限声明对页面插件无意义 |
| `mics.settings` / `mics.notifications` / `mics.core-workbench` | renderer / manifest | — | 同上 |

**默认安装下没有任何插件跑在子进程里**：`sandbox.mode` 默认 `off`；即使改成 `audit`，
唯一声明了 `sandboxed` 的内置插件 `mics.minekuai` 是 `defaultDisabled`。

## 4. 权限维度与强制程度

| 维度 | 声明 | 强制手段 | 强度 | 当前状态 |
| --- | --- | --- | --- | --- |
| 读/写目录 | `fs.read` / `fs.write` / `fs.meta` | `--allow-fs-read/write`（**目录前缀**，不支持 `*.jar`） | 引擎级 | 仅 `enforce` + `sandboxed` 生效 |
| 能否执行程序 | `exec[]` | `--allow-child-process`（全有全无） | 引擎级 | 同上 |
| 执行哪个程序 | `exec[].bin` / `args` | 无（broker 未实现 exec 路由） | **无** | 未强制 |
| 原生模块 / worker | — | `--permission` 默认禁止 | 引擎级 | 同上 |
| 联网域名 | `net.mode` / `hosts` | 无 | **无** | 子进程可以直接连任何地址 |
| 剪贴板 / 通知 / 对话框 / 外链 | `os.*` | 宿主代做 + 调用点校验 | 软拦 | 仅 `shell.openExternal` 有校验 |
| 能力（capability） | — | 宿主代理：`cap-call`；子进程不能 `provide` | 结构性 | 已生效 |
| 跨进程事件 | — | 只桥接 `plugins/changed` 与 `catalog/describe` | 结构性 | 已生效 |
| 存储 | — | 宿主代理，100ms 合并写回 | 结构性 | 已生效 |
| 宿主信息 | — | `ctx.host.paths` / `app` / `shell` | 结构性 | 已生效 |

“结构性”指：子进程里根本没有对应实现，只能经代理；不是策略判断。

## 5. 运行时开关

`boot.config.json`：

```json
{ "sandbox": "off" | "audit" | "enforce" }
```

| 模式 | 行为 |
| --- | --- |
| `off`（默认） | 所有插件在主进程内挂载，权限只用于展示 |
| `audit` | 非 `full` 的插件进子进程，**不加** `--permission`（只收集“如果开了会怎样”的数据） |
| `enforce` | 同上，并加载 `--permission` 与声明出来的白名单 |

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
- 本地：把 `boot.config.json` 的 `sandbox` 改成 `audit` 或 `enforce`，
  启用 `mics.minekuai`，或用「从文件夹安装」装上 `examples/hello-tool`。
