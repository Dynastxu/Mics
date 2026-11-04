# 迁移到 Cordis Loader / Include / Group

> 状态：挂载模型已对齐 dsh（Loader 建树 + await 静默），Include 已移除；
> 启动页与加载进度已就绪。HMR 已从分发中移除（改为开发期产物监视）；
> Group / isolate 已用于第三方插件隔离。
> 前置项已完成：`@mics/ui` 外部化（渲染侧插件总量 1.23 MB → 381 KB）、跨进程事件契约。

## 0. 已验证的事实（Node 冒烟，非推测）

在把 `PluginsService` 的挂载段换掉之前，用独立 Node 脚本验证了七件事
（脚本已删，结论如下，需要时可原样重放）：

1. `loader/patch-context` 在 fiber 建立**之前**触发，监听器可以写
   `entry.ctx[PLUGIN_ID] = entry.options.id`，插件 `apply` 里读得到；
2. `entry.options.config` 会原样成为 `apply(ctx, config)` 的第二参
   （`{ pluginId, manifest }` 可以直接放进 entry config）；
3. `entry.fiber` 才是可用的 fiber（`innerFiber` / `outerFiber` 在该版本里恒为空），
   `entry.fiber.state` 是 `FiberState`，`await entry.fiber.await()` 可等激活完成；
4. `loader.remove(id)` 会 dispose fiber 并执行 `ctx.effect` 的清理函数；
5. TimerService 挂在根上下文后，插件 `inject: ['timer']` + `ctx.timeout(cb, ms)` 可用，
   返回的取消函数有效，计时器随 fiber 回收；
6. 用**真实构建产物**（`plugins/shell/dist/main.mjs`）走完整链路：cordis shim 生效、
   fiber 进入 ACTIVE、卸载后能力注册被回收；
7. cordis 4 的 service 对**兄弟子树可见**（未 `isolate` 时），因此 Loader 挂在根上下文、
   插件 entry 与内核互为兄弟，仍然能注入 `ctx.ipc` / `ctx.storage` / `ctx.capabilities`；
8. Include 不用按文件路径加载：注册成内建即可
   （`loader.builtins.include = Include`，entry 的 `name: 'cordis:include'`），
   因此它可以随产物一起打包，不依赖安装目录里的 `node_modules`；
9. Include 的 entry 是**嵌套子树**，用 `loader.resolve('plugins:<id>')` 取，
   `entry.fiber` 与直接挂载时一致（实测 state = ACTIVE）；
10. **`entry.update({ disabled })` 只改内存、不写回文件**：只有走 Include 这棵树的
    `create / update / remove`（内部 `commit` → journal → 落盘）才会持久化。
    禁用/启用必须调用 Include 实例的这些方法，而不是单个 entry 的方法；
11. 文件被外部修改后（`watch: true` + fs-node）整棵树会重新应用，实测改回未禁用会重新挂载；
12. 若「重载」靠改 entry 的 `name` 加 `?mics=` 实现，查询串会被写进文件——所以重载要走
    `@cordisjs/plugin-hmr` 的模块替换，而不是改 name；
13. 更关键：**`tree.update(id, { name })` 只改配置、不会重新 import**（Entry 重挂载时
    `innerFiber` 没被清空，`_init` 直接提前返回）。可靠的重载是
    「`tree.remove(id)` → `tree.create({ id, name: url?v=… })`」，实测 apply 次数 +1。
    因此 `plugin-hmr` 仍是终态，remove+create 只是过渡手段；
14. `@cordisjs/plugin-hmr` 在本机（Node 24 + 已安装的 Node-API 依赖）**可以正常构造**，
    说明 `ModuleLoader.fromInternal()` 拿得到内部加载器；它没有显式的 `reload()` API，
    只有文件 watch，所以内核的「重载按钮」仍走 remove+create，HMR 的 `watch.root`
    暂时留空（不自动监视，避免与 `?mics=` 查询串的模块身份打架）；
15. `@cordisjs/plugin-logger-console` 的 `%o` / 颜色格式化确认可用
    （`2026-11-04 20:51:18 [I] smoke …`），因此开发构建的控制台输出改由它负责，
    mics.logger 不再自己镜像。

## 1. 为什么要换

现在的 `PluginsService`（`plugins/kernel/src/services/plugins.ts`，1310 行）同时承担了
五件事：扫描清单、依赖闭包、懒激活、状态机、持久化。其中「懒激活」被依赖闭包抵消
（`mics.launch` 是 onStartup，却依赖懒激活的 `mics.account`），真正的复杂度都花在了一个
并不成立的收益上。目标是把「挂载」交给 Cordis Loader，「存盘」交给 Include，「隔离」交给
Group，内核只保留清单解析与诊断。

## 2. 目标模型：两张表分工
| 介质 | 角色 | 谁写 |
| --- | --- | --- |
| `<userData>/cordis.yml` | **运行时真相**：有哪些 entry、各自 config、谁被禁用 | 安装器 / 插件面板 / 用户手改 |
| `plugins/<id>/plugin.json` | **发行格式**：安装校验、导航与命令元数据 | 插件作者 |

不允许两边都当真相。约定：**安装/卸载由安装器改写 yml**（entry 的 `name` 指向
`file://` 的 `dist/main.mjs`），`plugin.json` 只被读取、不被运行时修改。

entry 形状（Loader 的 `EntryOptions`）：

```yaml
- id: mics.account
  name: file:///…/plugins/account/dist/main.mjs
  config:
    manifest: { id: mics.account, nav: [ … ] }   # 清单随 entry 走，导航元数据不丢
  disabled: false
```

`cordis.yml` 是**生成文件**：`reconcileInclude()` 会按扫描结果补齐、删除条目。
手改 `disabled` 有效（启动时会被采纳为真相）；手写一条不属于任何插件目录的 entry
会在下一次对账时被移除。需要长期定制时应做成插件目录，而不是改这个文件。

## 3. 三个必须解决的缝隙
### 3.1 插件身份（`PLUGIN_ID`）

现有插件身份靠 `ctx.extend({ [PLUGIN_ID]: id })` 注入，Loader 自己建上下文。用 Loader 的 `loader/patch-context` 钩子补上：

```ts
ctx.on('loader/patch-context', (entry, next) => {
  ;(entry as any).ctx[PLUGIN_ID] = entry.options.id
  return next()
})
```

`pluginIdOf(ctx)` 沿原型链查找，插件与其子 fiber 都能读到，服务侧的「按插件隔离」
（storage / ipc / ui 归属）不需要改。

### 3.2 清单随行

插件当前从 `apply(ctx, config)` 的第二参拿到 `{ pluginId, manifest }`。改成从 entry 的
`config` 来，插件的 `apply` 签名与实现保持不变。`PluginsService` 仍负责扫描 `plugin.json`
（导航先于代码渲染这条不能丢），扫描结果只用于两件事：生成 entry 的 `config.manifest`、
做安装期校验与诊断。

### 3.3 渲染进程不动

Loader 依赖 Node 的模块加载器（`loader-utils` 的 `ModuleLoader`），浏览器侧用不了。
渲染进程保留现有 `runtime/services/plugins.ts` 的 `import(url)` 加载器，但在启动时把
**所有**插件的渲染半边加载一次（不再按页面激活）。这样主进程与渲染进程不会出现
「一边已挂载、一边还没加载」的半激活状态；导航仍来自清单，先于代码渲染。

## 4. 迁移步骤（每一步都可回滚）

1. **依赖与骨架（✅ 已完成）**：`apps/desktop` 增加 `@cordisjs/plugin-loader`、
   `@cordisjs/plugin-timer`（根 `devDependencies` 另加 timer，供 `@mics/sdk` 取类型）；
   bootstrap 在根上下文挂 `TimerService` 与空的 `Loader`；`electron.vite.config.ts`
   把两者从 external 列表排除，随产物打进 `out/main`（发布包只带 `out/**`）。
   旧激活路径继续工作，`pnpm typecheck / lint / build` 全绿。
2. **挂载切到 Loader（✅ 已完成）**：`startNow` 优先走
   `ctx.loader.create({ id, name: fileUrl, config: { pluginId, manifest } })`，
   取 `entry.fiber` 做状态跟踪；`stop` 走 `loader.remove(id)` + 等同一个 dispose；
   重载换 `?mics=<stamp>` 绕开 ESM 缓存。插件身份由 `loader/patch-context` 注入。
   Loader 服务缺失时自动退回原来的 `scope.plugin()` 路径。`disabled-plugins.json`
   与现有状态映射保持不变。
3. **切换真相源**：entry 由清单扫描生成（`buildPluginTree()`，见 `@mics/plugin-loader`；
   导航先于代码这条不能丢），写入 `<userData>/cordis.yml`，由
   `name: 'cordis:include'` 的 Include 条目挂载；禁用/启用调 Include 这棵树的
   `update(id, { disabled })` 以写回文件，`disabled-plugins.json` 只读一次做迁移。
   纯渲染插件没有主进程入口，暂时仍留在旧文件里——这是迁移期的已知分裂。
4. **删除自建状态机**：五态（activating/active/waiting/failed/disabled）改成 fiber 状态 +
   entry 上的失败原因；插件面板的诊断从 `entry` 重建。（进行中：状态映射已经以
   `entry.fiber` 为准；旧的逐插件挂载分支保留作为 Include 失败时的回退。）
5. **安装/卸载**：`packages/plugin-loader/src/install.ts`、`uninstall.ts` 改为
   `ctx.loader.create()` / `ctx.loader.remove()`，由 Include 负责写盘与对账。
   （已通过 `rescan → reconcileInclude` 达成，安装器本身不需要直接操作树。）
6. **收尾（✅ 已完成）**：Loader 的 import 失败只写 logger；`reconcileInclude` 现在会把
   「树里有 entry、但没有 fiber」的插件标成 `failed`（stage=import），插件面板能看见。

## 5. 必须一起改的判断

- **懒激活消失**：entry 全部 eager 挂载。主进程总量 514 KB，其中 onStartup 已占 486 KB，
  真正新增只有 `account`(24 KB) + `plugin-inspector`(3.5 KB)。渲染侧在 `@mics/ui`
  外部化后总量 381 KB，eager 可接受。
- **失败隔离**：Loader 的 `_import` 会 catch 并记录，不会拖垮启动；但失败**不会**自动出现在
  面板里，第 6 步补上。
- **审批位置**：`plugin/beforeActivate`（同步 bail）没有对应钩子。准入挪到安装期
  （`install.ts` 校验 + `plugin.json` 的 `permissions`）与组合期（yml 生成时）。

## 6. 其余包的采用顺序

| 包 | 用法 | 前置 |
| --- | --- | --- |
| `@cordisjs/plugin-timer` | 已挂到根上下文；`close-behavior` 的关闭框超时是第一个迁移点（`ctx.timeout` + `inject: ['timer']`），其余 46 处裸 `setTimeout` 按插件逐个迁移 | 无 |
| `@cordisjs/plugin-logger-console` | ✅ 开发构建的控制台输出由它接管（颜色 / `%o`），mics.logger 只写文件 | 无 |
| `@cordisjs/plugin-fs-node` | 已挂到根上下文；Include 的 `watch` 与后续插件目录热发现的底座 | ✅ 已挂载 |
| ~~`@cordisjs/plugin-hmr`~~ | 已移除：它需要 Node 内部加载器，且没有显式 reload API。改为开发期用 `fs` 监视插件产物、复用现有 reload（见第 10 节） | — |
| `@cordisjs/plugin-group` | ✅ 已注册为 `cordis:group` 内建；当前没有子树需要 isolate（mics 的服务按 pluginId 归属就够），等多窗口 / 多实例再启用 | Loader |
| `@cordisjs/plugin-package-manager` | 暂不采用：要求运行时存在 pnpm，破坏「零外部依赖」 | — |

## 7. 与 dsh 启动链的对照

dsh 的启动链在 `packages/client/web/src/`，值得照搬的是三点：

| dsh | mics 对齐方式 |
| --- | --- |
| `boot-page.ts`：框架无关的启动页（wordmark + 旋转圆环 + “Loading plugins…”），进度 = 已激活 / 总数，失败时列 entry id 且不挂载 UI | `apps/desktop/src/renderer/boot-screen.ts`：原生 DOM 覆盖层，在 `createApp()` 之前画出，按插件加载进度转圆环；失败列出插件 id，4 秒后退场 |
| `boot-client.ts`：`loader.create` 每条 → `await loader.await()` → `assertEntriesActive()` 逐条审计（无 fiber = import 失败；pending 报缺哪些服务） | 内核 `settleInclude()` 改用 `loader.await()`（覆盖 Include 子树），之后才判“无 fiber = import 失败”；渲染端保留 pending fiber 由 cordis 自动激活 |
| 进度来自 `internal/status` 事件，无定时器 | 渲染端在 `activateAll()` 里按完成数上报进度；内核不再用 1.5s 定时器判失败 |

仍未对齐的一处：dsh 启动失败时**不挂载 UI**；mics 仍会进入主界面，只把失败项摆在启动页与插件管理里——因为 mics 的插件管理页是用户修复插件的唯一入口，隐藏 UI 会让人无从恢复。

### 顺序约束（踩过一次）
`loader.await()` 是对的，但**不能放在 `PluginsService.[Service.init]` 里**：插件会 `inject: ['ipc']`，
而 `ipc` 是内核在这之后才 `ctx.plugin()` 的服务。在 init 里等，那些 fiber 会永远 pending，
内核也就永远走不到挂载 `ipc` 的那一步，形成死锁（表现为"大量插件等待依赖"）。

正确位置是内核服务全部就绪之后、对外注册 `runtime/snapshot` 之前：
`ctx.inject([...services], async (ctx) => { await ctx.plugins.mountPlugins(); ... })`。
`mountPlugins()` 只跑一次（共享同一个 promise），并且必须早于 snapshot RPC，渲染端才不会拿到半成品状态。

## 8. 最终形态：Include 已移除

对齐 dsh 的 `entries.start` 模型之后，挂载不再经过 Include：

- 内核 `syncTree()` 自己 `loader.create` 每个 entry → `await loader.await()` → 绑定 fiber；
- `cordis.yml` 退化为**部署状态文件**（主要是 `disabled`），由内核读写；
- 轮询 `waitForIncludeEntries`、延迟对账、`includeSettled` 全部删除；
- `@cordisjs/plugin-include` 依赖与 `cordis:` 内建注册一并移除（主进程产物 524 KB → 262 KB）。

保留的一处顺序约束：`mountPlugins()` 必须在 `ipc` 等服务就绪之后调用（否则 inject ipc
的插件永远 pending，内核走不到挂载 ipc 那一步）。

## 10. HMR 与 Group 的最终处置

**HMR**：开发期便利，不应进入分发包。

- Cordis HMR 需要 Node 内部 ESM 加载器（`--expose-internals` 或原生 addon）；
- 实测（Electron 45.0.0 / Node 24.22.0）：`node-addon-require-builtin@0.1.9` 会**拒绝**该运行时——
  它按 V8 指纹白名单放行（仅 43.0.0、44.0.0、44.7.0、45.0.0-alpha.6），本机不在其中。
  因此 HMR 在当前 Electron 上不可用，这不是接线问题；
- 启动时先做前置检查，只有内部加载器可达才挂 HMR；否则完全不挂，避免"挂了但构造抛错"；
- 实际生效的是内核在 **`app.isDev` 时**监视每个插件的 `dist/main.mjs`，防抖 300ms 后走
  现有 `reload()`（`remove + create`）。分发版本不安装监视，也不含 HMR 依赖；
- 若将来 addon 支持 45.0.0 stable（或 Electron 升级到受支持版本），前置检查会自动放行，
  无需改代码。

**Group / isolate**：已落到一个真实用途——第三方插件隔离。

- `record.source === 'user'` 的 entry 创建时带 `isolate: { plugins: true }`；
- 该子树里 `ctx.plugins` 不可见，第三方插件因此**无法禁用/重载其它插件**；
- 内置插件不受影响（`plugin-inspector` 仍能管理插件）；
- 已验证：内置插件正常激活，第三方插件停在 pending、`apply` 不执行。

多窗口那种"每窗口一套同名服务"仍属产品功能，不是 Group 的适配问题：真正的工作量在
把窗口级服务（`ui` / `notifications`）的**提供方**改为在窗口组内挂载，而不是现在的根上下文。

## 11. 多窗口对冲（已落地）

多窗口真正难的不是"再开一个 BrowserWindow"，而是**服务边界**：现在 `ui` / `notifications` /
关闭确认框这些只在单窗口下成立。为避免以后推翻重来，先做了三件不改变现有行为的事：

1. **事件定向协议**：`RuntimeEventEnvelope.target`（webContents id）+
   `ipc.broadcast(topic, payload, source, target)`；preload 拿到自己的 `windowId` 并过滤
   不属于本窗口的帧。单窗口时不传 `target`，行为与之前完全一致。
2. **服务边界约定**（新增代码必须遵守）：
   - 留在根上下文（真正全局）：`kernel`/`loader`/`ipc`/`storage`/`permissions`/`logger`/
     `shell`/`download.manager`；
   - 窗口级候选（多窗口时必须进窗口组，不得挂根）：`notifications`、关闭确认框状态、
     任何"当前窗口"语义的服务；
   - 渲染端服务（`ui`/`theme`/`notifications` 队列）本来就每个窗口独立，不需要改。
3. **树结构已支持窗口组**：`syncTree` 按行建树，`cordis:group` 已注册。多窗口时把某个窗口
   的行包进一个 group 并 `isolate` 相应服务即可，不需要重写宿主或插件加载逻辑。

仍未做：窗口管理器（第二窗口的生命周期、窗口级 context 树）。它属于产品功能，
不构成架构阻塞——上面三件事才是"以后再补会很贵"的部分。

## 11. 验收真实产物（`plugins/shell/dist/main.mjs`）走 Include 的完整链路，7/7 通过：

| 检查 | 结果 |
| --- | --- |
| 由 Include 挂载并进入 ACTIVE | ✅ |
| 能力注册可见 | ✅ |
| 禁用后能力撤销 | ✅ |
| 禁用写回 `cordis.yml` | ✅ |
| 重新启用后恢复 | ✅ |
| 从树里移除（卸载路径）后撤销 | ✅ |
| 移除写回文件 | ✅ |

其他门槛：`pnpm typecheck` ✅、`pnpm lint` ✅（0 error）、`pnpm build:plugins` ✅、
`pnpm --filter @mics/desktop build` ✅；渲染侧插件总量 **381,119 字节**（< 400 KB），
目录页产物里已不再包含 `@mics/ui` 的组件代码（重复打包已消除）。

Electron 里的运行期点检（启动、点开各页面、开关插件）仍需在开发机上做一次；
若 Include 挂载或对账失败，启动日志会出现「回退到逐插件挂载」，应用行为等同迁移前。

