# 架构：一切皆插件

## 1. 分层

```
┌─ bootstrap（apps/desktop/src/main，唯一的非插件代码，~100 行）──────────────┐
│  app 生命周期 / 窗口 / mics-plugin:// 协议 / 创建 cordis 根 Context          │
│  读取 boot.config.json 找到内核插件 id                                      │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ root.extend({ [PLUGIN_ID]: id }).plugin(内核)
┌──────────────────────────────▼──────────── 主进程 ─────────────────────────┐
│ plugins/kernel —— 内核插件，也是普通 cordis 插件                            │
│   ├─ PluginsService     清单 → Loader entry 的映射、依赖顺序、状态跟踪        │
│   ├─ IpcService         mics:rpc 路由、mics:event 广播、调用方追踪           │
│   ├─ CommandsService    声明式命令 + 实现注册，执行前按需激活                │
│   ├─ StorageService     按 pluginId 隔离的 JSON 存储                        │
│   ├─ PermissionsService 清单权限校验                                        │
│   ├─ MainWindowService  主窗口生命周期（销毁 / 重建，低内存托盘）            │
│   └─ 其余插件由 PluginsService 经 Cordis Loader 挂载（entry → fiber）        │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ preload contextBridge（唯一通道）
┌──────────────────────────────▼──────────── 渲染进程 ───────────────────────┐
│ 渲染器 shell 也是一个 cordis 应用                                            │
│   ├─ bridge     window.mics 封装（RPC + 事件）                              │
│   ├─ ipc        插件间 RPC（先查本地，再转发主进程）                         │
│   ├─ commands   本地命令 + 远端命令                                          │
│   ├─ ui         导航页面 / 状态栏注册表（注册即 effect）                     │
│   ├─ theme      CSS 变量主题                                                 │
│   ├─ plugins    懒加载 UI 插件、维护 fiber 与插件作用域                       │
│   └─ Vue 组件只读 store；WindowTitleBar / NavPanel / MainArea / PageHost 只  │
│      负责画窗口装饰、导航与当前页面                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

三条原则：

1. **bootstrap 不做业务**。它只负责「找到内核 → 建 Context → 开窗口」。
2. **内核是插件**。内核只比别的插件多一个特权：它被 bootstrap 第一个挂载，并负责挂载其余插件。
3. **清单先于代码**。`plugin.json` 在插件未加载时就提供导航、命令、主题的元数据，
   因此左侧导航可以立刻画出来，页面代码按需加载。

## 2. Cordis 映射

| Cordis 概念                      | 在本项目中的职责                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Context`                        | 一切服务的容器；渲染进程也有一棵独立的 Context 树                                                                      |
| `ctx.plugin(plugin, config)`     | 插件激活；返回 `Fiber`，await 即等待激活完成                                                                           |
| `ctx.effect(() => cleanup)`      | 注册页面/命令/IPC 时的回收钩子；插件卸载自动执行                                                                       |
| `ctx.inject(deps, cb)`           | 依赖多个服务后再执行（内核注册系统 RPC 时用到）；服务缺失时插件停在 waiting                                            |
| `ctx.waterfall('ipc/before', …)` | RPC 派发前的拦截链：权限、审计、二次确认挂在插件侧，内核不再逐条加 if                                                  |
| `Service` 子类                   | 内核能力：`plugins` / `ipc` / `commands` / `storage` / `permissions` / `capabilities` / `configuration` / `mainWindow` |
| `ctx.isolate()`                  | 后续用于单插件服务隔离（例如独立日志命名空间）                                                                         |
| `ctx.on/emit`                    | 主进程内部事件；每个 Mics 事件在 `@mics/sdk` 的 `EVENT_MODES` 里声明派发模式，见下文「事件派发模式」                   |
| `ctx.registry`                   | 插件面板可据此列出所有 fiber（后续扩展点）                                                                             |

### 事件派发模式

cordis 4 提供五种派发模式，Mics 的每个事件都必须先登记模式再派发：

| 模式        | 语义                                      | 当前事件                                                                                                                                                                 |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emit`      | 通知，同步执行，返回值丢弃                | `plugins/changed`、`plugin/activated`、`plugin/deactivated`、`ipc/after`、`capability/changed`、`download/*` 的完成通知、`mods/removed`                                  |
| `bail`      | 同步投票，第一个非空返回值即结论          | `plugin/beforeActivate`（审批：`{ allow: false, reason }` 拒绝激活）                                                                                                     |
| `waterfall` | 中间件，监听器拿到 `next()`，可短路或改写 | `ipc/before`（权限、审计、限流、二次确认）、`catalog/describe`（目录名称/描述的翻译扩展）、`download/targets`、`download/commit`（任务目标与落盘方式改写）               |
| `serial`    | 串行等待，遇到第一个结论即停止            | `download/create`、`download/addFiles`、`download/awaitFiles`、`download/seal`、`download/finish`、`download/retry`、`game/*`、`loader/*`、`catalog/resolveModpackFiles` |
| `parallel`  | 扇出，等全部监听器完成                    | 暂无（纯并行的收尾工作使用）                                                                                                                                             |

声明集中在 `packages/sdk/src/contract/events.ts`：

- `MicsEvents` 定义事件签名，`EVENT_MODES` 记录模式；新增事件却忘记登记模式会编译失败；
- 派发方用 `emitEvent` / `bailEvent` / `waterfallEvent` / `serialEvent` / `parallelEvent`，
  事件名与模式不匹配是编译错误；
- 开发模式下 `plugins/kernel/src/eventModeAudit.ts` 监听 `internal/dispatch`，
  实际派发模式与声明不符时打 warning；生产构建不挂这个审计。

这样「`emit` 之后有没有人改返回值」不需要读派发点猜，类型和声明会直接回答。

下载子系统是这套事件模型的第一个大用户：下载管线（`mics.download.manager`）只实现
`download/*`，原版、加载器、社区来源与各分类插件通过 `serial` 事件提交「文件 + 候选源」，
通过 `download/filesDone` / `download/finish` 收尾。管线的职责与契约见
[download-pipeline.md](download-pipeline.md)。

`catalog/describe` 是目录文案的扩展点：社区目录插件（`mics.download.catalog`）在主进程返回目录 RPC 之前派发，
监听器按来源原文改写名称/描述；未命中时原样返回 `next()`。缓存、搜索与指纹识别
仍然只看到原文，派发方会吞掉监听器异常并回退原文，翻译插件不能阻断目录打开。

展示名被改写时，派发方会把改写前的名称留在 `ModSummary.originalName`（未改写时为空）。
详情页的「复制名称」读这个字段：没有原文，中文目录里复制出去的就是中文名，
贴到 Modrinth / CurseForge 的搜索框里什么也搜不到。

### 跨进程事件（`ipc:` topic）

事件有两层，不能混：

| 层            | 用法                                                                            | 能跨进程吗                                 |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Cordis 事件   | `ctx.emit` / `waterfall` / `bail` / `serial` / `parallel`，上面的 `EVENT_MODES` | 不能：参数里有 `next()`、`ctx`，不可序列化 |
| Runtime topic | `ctx.ipc.emit/on`，payload 必须可序列化                                         | 能：主进程经 `mics:event` 广播到每个窗口   |

两者靠**前缀**区分：topic 一律以 `ipc:` 开头。

- 主进程 `broadcast()` 发完窗口后，会在本地再派发一次同名 Cordis 事件
  （[ipc.ts](../plugins/kernel/src/services/ipc.ts)）；
- 渲染进程在 `boot()` 里装一个边界适配器，把收到的每一帧重新派发成本地事件
  （[context.ts](../apps/desktop/src/renderer/runtime/context.ts)）。

因此插件在**两个进程里写同一行代码**：

```ts
ctx.on('ipc:plugins/changed', (snapshot) => {
  /* ... */
})
```

不需要知道事件从哪个进程来。契约用模块增补登记，topic 名与 payload 类型只有一个来源：

```ts
declare module 'cordis' {
  interface Events {
    'ipc:my-plugin/changed'(payload: MyPayload): void
  }
}
```

`@mics/sdk` 的 `WireTopic` 按前缀自动把 topic 从普通事件里挑出来，
`ctx.ipc.emit` / `ctx.ipc.on` 都按它做类型检查。**跨进程只做 `emit` 语义**：
`waterfall` / `bail` 依赖返回值与短路，需要「请求—响应」时走 RPC。

### 调用方追踪（traceable）

Cordis 的 Service 方法在被插件调用时，`this.ctx` 会指向**调用方插件的作用域**。因此：

- `ctx.storage.get('k')` 自动落到调用方插件自己的 JSON 文件；
- `ctx.ipc.handle('x', fn)` 自动登记到调用方插件 id 下，并在其卸载时移除；
- `ctx.ui.registerView(...)` 注册的页面会随插件 fiber dispose 一起消失；
  `ctx.ui.registerSettingsSection(...)` 同理。

这就是为什么插件里不需要手写 `pluginId` 参数。

> 注意：插件 id 存在 `PLUGIN_ID` 这个 **Symbol 键**上，用 `pluginIdOf(ctx)` 读取。
> 不能写成 `ctx.pluginId`——cordis 的 Context 代理会把未注册的字符串属性当作服务解析，
> 在没有该服务的上下文里会抛 `cannot get property "pluginId" without inject`。
>
> 同理，**从插件上下文访问任何服务都必须在 `inject` 里声明**。内核/渲染器的服务内部
> 在需要访问兄弟服务时，一律使用自己构造时的上下文（`owner`），而不是被追踪到调用方的
> `this.ctx`——调用方未必声明了那个 inject。
>
> 日志与通知不提供服务，只订阅事件：`mics.logger` 监听 `ipc:log/write`，并把
> cordis `ctx.logger` 的输出接到文件；`mics.notifications` 监听 `notification/show`。
> 调用方用 `writeLog()` / `emitNotification()` 发事件，不需要 `inject`，因此两插件都可以
> 被禁用：禁用后事件没有订阅者，自然丢弃，不会让任何依赖方停在未激活状态。
> 日志插件通常不是第一个激活的：cordis LoggerService 自带滚动缓冲区，日志插件激活时
> 先补录启动阶段的消息，再接管 `ctx.logger` 的导出；渲染进程没有文件系统权限，经
> `ipc:log/write` 把日志汇总到同一文件。

### 能力（capability）：definition / provider / consumer

Service 是「一个名字一个实现」，而有些能力需要**多份实现**（本机 / 沙箱 / 远程）。
这类能力走 `ctx.capabilities`：

| 角色       | 位置                                                                     | 例子                                                                                    |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| definition | `@mics/sdk` 的 `capability.ts` / `account.ts`：能力名 + 接口             | `SHELL_EXECUTE` / `FILE_TRANSFER` / `AUTH_CREDENTIALS`                                  |
| provider   | 插件在 `apply()` 里 `ctx.capabilities.provide(name, impl, { priority })` | `mics.shell` 提供本机进程，`download-manager` 提供本机传输，`mics.account` 提供启动凭据 |
| consumer   | `ctx.capabilities.require(name)`                                         | `mics.launch` 启动游戏、下载管线传输文件                                                |

选择规则是「priority 高的赢，同优先级后注册的赢」。因此沙箱插件只要注册同名能力并给
更高 priority，就能整体替换执行方式，调用方一行不用改。`provide()` 绑定在提供方 fiber
上，插件卸载时实现自动撤销并广播 `capability/changed`。

与 Service 的分工：**能力名是契约，Service 名是实现入口**。需要「换实现」的用能力，
需要「拿运行时服务」的（storage / ipc / logs）继续用 inject。

`AUTH_CREDENTIALS` 是这条分工的另一个例子：账户插件负责 Microsoft 设备码登录与离线账户，
启动插件只要求一份 `LaunchCredentials`（名字、UUID、令牌、`user_type`、额外 JVM 参数）。
新增第三方登录（Yggdrasil / authlib-injector）只需要在账户插件里加一个 provider，
启动插件与页面不受影响。

### 配置 schema 与 profile

`ctx.storage` 不再只是裸 JSON：清单声明 `contributes.configuration` 后，`StorageService`
按 schema 做「用户值 → profile 默认 → schema 默认」的取值与写入校验。schema 由
`ConfigurationService` 持有（从 `PluginsService` 的清单实时读取），因此热重载后立刻生效，
插件代码仍然只需要 `ctx.storage.get/set`。

- 设置界面：插件管理页的插件详情通过 `configuration/list|set|reset` 渲染简单类型；
  设置项多或需要专门界面的插件用 `settingsView` 指向自己的页面，详情里只给入口，
  双方共享同一套 schema 校验。所有设置页统一用 `@mics/ui` 的
  `SettingsPage` / `SettingsGroup` / `SettingsRow` 三层模板，其它插件可以通过
  `ctx.ui.registerSettingsGroup({ pageId, ... })` 往任意设置页追加分组。
  见 [settings-ui.md](settings-ui.md)。
- profile：`boot.config.json` 的 `profile` 指向 `userData/profiles/<name>.json`。
  `enable` / `disable` 是强制开关（`disable` 优先），`settings` 是 schema 原始类型键的
  默认值（用户保存过的值优先）。
- 诊断：`PluginGraphReport.profile` 与配置项的 `source` 让插件管理页 / agent 知道
  某个值是用户设置、profile 默认还是 schema 默认。

## 3. 启动时序

```
app.whenReady()
  ├─ scanPlugins(pluginRoots)            # 读取所有 plugin.json
  ├─ registerPluginProtocol(records)     # mics-plugin://<id>/<path>
  ├─ new Context()
  ├─ root.extend({ [PLUGIN_ID]: 'mics.kernel' }).plugin(kernel, config)
  │    ├─ 内核注册 plugins/ipc/commands/storage/permissions/capabilities/configuration 服务
  │    ├─ 注入完成后注册系统 RPC
  │    └─ activateStartup()（不阻塞；mics.logger 建立日志文件并补录启动阶段日志）
  ├─ createMainWindow()
  └─ loadRenderer(window)
        └─ 渲染进程 boot()
             ├─ 创建渲染器 Context，注册 bridge/ipc/commands/ui/theme/plugins
             ├─ 日志出口发出 ipc:log/write 事件（渲染端日志写进同一个文件）
             ├─ plugins 服务拉取 runtime/snapshot（清单层面）
             └─ NavPanel 画出导航；MainArea 显示当前页面 → plugins.activate(pluginId)
                  ├─ 主进程：import main.mjs → ctx.plugin()  （若 hasMain）
                  └─ 渲染进程：import renderer.mjs → ctx.plugin()（若 hasRenderer）
```

## 4. 导航与页面

左侧导航完全由清单贡献：

```json
{
  "contributes": {
    "navGroups": [{ "id": "download", "title": "下载", "icon": "download", "order": 20 }],
    "nav": [{ "id": "download.mod", "group": "download", "title": "Mod", "order": 20 }]
  }
}
```

- `navGroups` 只声明分组标题、图标与顺序，分组本身不绑定页面。
- `nav` 条目缺省 `group` 时是顶层页面（如「启动」），带 `group` 时挂在对应分组下。
- `nav[].id` 同时是渲染器的页面注册键：`ctx.ui.registerView(navId, component)`。
  这样清单可以先画导航，组件等到第一次打开页面时才加载。
- 没有子项的分组不显示；分组只提供标题与顺序，子项归属于各自插件，激活互不影响。
- 页面归属插件决定激活对象：点击导航项 → `plugins.activate(nav.pluginId)`。
- 页面首次打开后保持挂载（`MainArea` 的页面栈）：切换导航只切 `visibility`，搜索词、筛选、
  详情选择与各页自己的滚动位置都保留；插件被禁用 / 卸载时对应页面从栈中移除，重新启用后
  重新挂载。页面组件因此会持续存活（后台轮询与 IPC 订阅继续生效），元素 `id` 也需在所有
  已挂载页面间保持唯一。
- 插件可以调用 `ctx.ui.navigate(viewId)` 切到任意已注册页面（例如安装受理后跳到下载进度）；
  目标页面不存在（插件缺失或被禁用）时返回 `false`，由调用方决定如何提示。
- 需要给页面带参数（例如从实例 Mod 列表跳到 Mod 详情）时，**不能只在 setup 里读一次性状态**：
  页面常驻，第二次跳转不会重新执行 setup。消费者应同时监听 `ui/viewActivated`，在页面每次
  重新激活时再读一次待处理意图。
- 跳转意图可以携带来源页面（`origin: { view, label }`）。目标页面没有内部返回历史时，
  「返回」应回到来源页面，而不是退回自己的搜索页——例如从实例详情跳到 Mod 详情后返回启动页。
- 需要在「设置 → 通用」里追加配置区块的插件，调用
  `ctx.ui.registerSettingsSection({ id, title, order, component, props })`。区块带自己的
  `order`，设置页只负责按序渲染——设置页不 import 任何具体插件，插件也不依赖设置页存在。
  `props` 在注册时固定（通常是插件自己的 `ctx`），因为设置页的 `usePluginContext()` 拿到的是
  `mics.settings` 的上下文，不能代表注册方。

## 5. IPC 协议

单一通道 + 信封：

```ts
// 渲染 → 主
{ target: 'mics.launch', method: 'instances/list', params: undefined, callerId }
// 主 → 渲染（返回）
{ ok: true, value } | { ok: false, error: { message } }
// 事件（双向）
{ topic: 'plugins/changed', source: 'mics.kernel', payload, ts }
```

- 方法由内核按 `插件 id + 方法名` 路由；目标插件未激活会直接报错（可由调用方先激活）。
- `callerId` 是「尽力而为」的标识，用于能力校验与审计，不是安全边界。
- 派发前后各有一个挂载点：`ipc/before`（waterfall，返回 `RpcResponse` 即短路）与
  `ipc/after`（观察）。权限校验是内核注册的第一条 `ipc/before`；审计、限流、二次确认
  由插件自己挂同名链，不需要改内核代码。
- `plugins/diagnostics`：只读诊断，返回依赖图、贡献点与未满足项。插件管理页与
  agent 读同一份数据（见 `packages/sdk/src/contract/diagnostics.ts`），不各自推断。

## 6. 窗口与自绘标题栏

窗口是无边框的（`frame: false`），系统标题栏、菜单栏、窗口按钮都不显示：

| 关注点     | 实现                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 系统菜单   | bootstrap 里 `Menu.setApplicationMenu(null)`；开发/预览构建下用 F12（或 `Ctrl+Shift+I`）开 DevTools、`Ctrl+R` 重载渲染进程                             |
| 标题栏     | `shell/WindowTitleBar.vue`；拖动区用 `-webkit-app-region: drag` 交给系统，双击最大化、贴边吸附都是系统行为                                             |
| 窗口按钮   | 按钮区 `-webkit-app-region: no-drag`，点击经 `window.mics.windowControls` → IPC → 主进程 `BrowserWindow`                                               |
| 侧边栏开关 | 应用名右侧，与 `Ctrl+B` 共用 store 的 `toggleNav`；`aria-expanded` + `aria-controls="mics-nav"` 指向左侧导航，开关只在 `store.ready` 后可点            |
| 最大化状态 | 主进程监听 `maximize` / `unmaximize` 推给渲染进程，标题栏据此在「最大化 / 还原」之间切换图标                                                           |
| 窗口可见性 | 主进程按 `isVisible() && !isMinimized()` 推 `visible`；图标入场动画等它为 true 才播放。隐藏窗口里 Electron 仍在绘制，`document.visibilityState` 不可信 |
| 窗口尺寸   | `main/windowSizing.ts`：最小 640×420，启动尺寸不超过当前工作区；状态栏「命令」右侧有一个拖动区，按住拖动即可缩放窗口（左上角固定，只受最小尺寸限制）   |
| 关闭行为   | `plugins/close-behavior` 拦截 `BrowserWindow` 的 `close`：按设置询问（带「不再提示」）/ 直接退出 / 隐藏到托盘；托盘菜单提供恢复与退出                  |

壳专用的 IPC 通道：

- `mics:window-control`：渲染 → 主，`minimize` / `toggle-maximize` / `close`；
  主进程用 `BrowserWindow.fromWebContents(event.sender)` 只操作发消息的那个窗口。
- `mics:window-resize`：渲染 → 主，`{ phase: 'start' | 'move' | 'end', x, y }`；
  指针用屏幕坐标，主进程以按下时的 bounds 加上位移算出新宽高，左上角保持不动，
  只夹最小尺寸；最大化时先还原再继续。
- `mics:window-state`：主 → 渲染，`{ maximized, visible }`；最大化、显示 / 隐藏、最小化 / 还原
  都会推，渲染进程挂载时再 `invoke` 拉一次，因为窗口重载时状态事件可能早于监听。

窗口装饰和导航容器、状态栏一样属于外壳，不作为插件贡献点。**关闭策略是行为而不是装饰**：
`mics.close-behavior` 通过内核的 `ctx.mainWindow` 服务注册关闭拦截器，不直接
`new BrowserWindow()`。主窗口的创建配置（无边框、preload、导航拦截、窗口状态跟踪）
只在 bootstrap 的 `MainWindowHost` / `createMainWindow` 里维护一份；插件只能请求
「显示 / 隐藏 / 销毁 / 重建」，窗口生命周期仍归外壳。

确认框不是系统消息框，而是 `@mics/ui` 的 `ConfirmDialog`（与删除实例、安装插件等共用）。
主进程拦截 `close` 后先把主窗口恢复并聚焦（从任务栏关闭、窗口最小化时确认框不能渲染在
看不见的后台窗口里），再广播 prompt request；渲染端的全局确认框宿主显示后回 ack；用户选择
后再经 `prompt/respond` RPC 把结果交回主进程——确认框可以带「不再提示」复选框，勾选后把
这次选择写回 `ctx.storage`，与「设置 → 通用 → 关闭与托盘」读写同一个值。渲染端没有在显示时限内
ack（例如渲染进程未就绪）时，主进程按最小化至托盘处理；隐藏后仍可从托盘菜单退出，不会把
应用锁死在无法关闭的状态。托盘创建失败时保持窗口可见，避免应用失去唯一入口。

### 低内存托盘

「设置 → 通用 → 关闭与托盘」里的低内存托盘模式默认开启。选择「最小化至托盘区」时，插件先创建托盘，
再调用 `mainWindow.destroy({ keepAlive: true })`：主窗口与渲染进程被销毁、内存归还；
`window-all-closed` 因为 `keepAlive` 不退出应用。托盘菜单「显示主界面」调用
`mainWindow.show()`，宿主用同一份窗口配置重建窗口，并恢复上次的尺寸 / 位置与最大化状态；
渲染端带 `restore=1` 启动，从 `localStorage` 恢复上次页面。`before-quit` 会清掉
`keepAlive`，真正退出时仍走正常退出流程。

代价是页面状态会丢：页面栈里未提交的表单、打开的弹窗、滚动位置不会保留；下载、启动等
主进程任务不受影响。需要即时恢复完整页面状态时，可以在「设置 → 通用 → 关闭与托盘」里关掉这个模式。

## 7. 信任与权限模型（当前阶段）

- **主进程插件**：拥有完整 Node 能力，清单里的 `permissions` 用于声明与审计。
- **渲染进程插件**：与 shell 共享页面，属于「可信插件」模型；清单权限由宿主服务
  （如 `host/openExternal`）在调用时校验。
- **已有的最小隔离**：窗口开启 `sandbox` / `contextIsolation`、关闭 `nodeIntegration`，
  插件本来就没有 `require` / `electron`；每个渲染端插件的上下文再 `isolate('bridge')`，
  只能经 `ctx.ipc` 访问主进程，拿不到壳专用的 `ctx.bridge`。`ui` 注册表按插件记录归属，
  跨插件覆盖同一个 view / 状态栏 id 会直接失败。
- `window.mics` 仍由 preload 暴露给整个页面，完整 iframe / utility process /
  per-plugin JS 隔离在路线图 M3；当前的限制是「防误用与互相覆盖」，不是安全边界。

### 开发模式清理审计

清理审计分两侧：

- 主进程：dev 下包装 `ipcMain.handle/on/remove…`，记录注册堆栈；插件重载后对比上一次
  快照，`ipcMain` 注册数量增长时打印新增通道与堆栈。
- 渲染端：dev 下包装 `window` / `document` 的监听器与 `setInterval`，同时统计 view、
  状态栏、样式与命令数量；每个插件第一次重载建立基线，之后数量增长才告警。
- 第一次重载只建基线，避免把插件在 `apply` 里注册的长期监听器误报成泄漏；生产构建
  不安装这些包装，也不改变全局函数。

## 8. 构建管线

```
plugins/<id>/src/main.ts      ──vite ssr──▶  dist/main.mjs      (electron, cordis external)
plugins/<id>/src/renderer/*   ──vite lib─▶  dist/renderer.mjs  (vue/cordis → shim)
plugins/<id>/**/*.vue|css     ───────────▶  dist/style.css     (清单 styles 声明后由 shell 注入)
```

`vue` 与 `cordis` 不被打进插件：构建时生成 shim（`node_modules/.mics/*-shim.js`），
shim 从 `globalThis.__MICS_VUE__` / `__MICS_CORDIS__` 读取 shell 注入的实例。
这样可以保证 `Service`、`Context`、响应式系统的**身份唯一**，否则 `instanceof` 与
依赖注入都会失效。

主进程侧同理：插件 `import 'cordis'` 会解析到根 `node_modules` 里的同一份 cordis。

## 9. 共享 UI 组件（@mics/ui）

下载页的筛选 / 列表与各插件的确认框是跨页面通用件，独立成
`packages/ui`（`@mics/ui`）：

| 组件            | 职责                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FilterButton`  | 漏斗按钮 + 非默认筛选圆点，`v-model:open` 控制面板                                                                                         |
| `FilterPanel`   | 按 `FilterGroup[]` 渲染分组胶囊；`single` 单选、`multi` 多选，`exclusive` 选项（「全部」）与其它互斥                                       |
| `DataList`      | 通用行渲染（主文本 + 徽标 + 次要文本）；`role="button"` 整行进入，`role="radio"` 单选并显示勾，`role="static"` 仅展示；`#row` 插槽自定义行 |
| `DataBrowser`   | 搜索 + 筛选 + 计数标题 + `DataList`；内部持有查询与筛选状态，调用方只给 `items` 与 `@select`                                               |
| `ToggleSwitch`  | 开关按钮，`v-model` 布尔值；用 `role="switch"` 与 `aria-checked` 表达状态                                                                  |
| `ConfirmDialog` | 内部确认框：两个可配样式的按钮 + 可选「不再提示」复选框、`busy` 状态；关闭确认 / 删除实例 / 安装卸载插件共用，不弹系统消息框               |

为什么是包而不是「组件插件」：插件各自独立打包，运行时组件注册表拿不到 props 类型，
也保证不了加载顺序；静态引入让编译期就能校验，每个插件也只打包用到的组件。
组件复用 shell 的 `mics-*` 设计系统类，自带的 scoped 样式会进插件的 `dist/style.css`，
因此使用方必须在 `plugin.json` 里声明 `styles`。

## 10. 挂载模型、状态与贡献点

**挂载**（dsh 的 `entries.start` 模型）：

- 启动代码（内核 `syncTree()`）按扫描结果**自己创建每个 entry**，然后
  `await loader.await()`；entry 与 init 任务在 await 之前就已存在，因此不需要
  轮询或延时去等"文件解析完"；
- `<userData>/cordis.yml` 只保存部署状态（主要是 `disabled`）：启动时读它合并禁用集合，
  变更后由内核整份重写；条目增删由目录扫描决定，手写条目会在下次对账时被移除；
- 禁用/启用是 `loader.update(id, { disabled })`；重载是 `remove + create`（换查询串
  强制重新 import）；安装/卸载后 `rescan → syncTree` 让树与目录对齐。

> 曾短暂采用过 Cordis Include 挂载整棵树，但它由文件异步建行、`loader.await()` 会
> 在空树上立即返回，只能靠轮询补偿，因此改回上面这种"启动代码建树"的模型。

渲染进程在启动时把**所有**插件的渲染半边加载一次（不再按页面激活）。导航仍由清单
在代码加载前渲染，因此首屏不依赖插件执行。`activation` 字段现在只用于诊断展示。

- **状态**（目录是「已安装」的唯一事实来源）：

  | 状态     | 含义                                                | 界面                         |
  | -------- | --------------------------------------------------- | ---------------------------- |
  | 启用     | 目录在、entry 的 fiber active                       | 开关打开                     |
  | 等待依赖 | entry 在、fiber pending：`inject` 的服务没人提供    | 徽标「等待依赖」+ 缺哪些服务 |
  | 禁用     | 目录在、entry `disabled: true`（写回 `cordis.yml`） | 开关关闭                     |
  | 失败     | entry 在、没有 fiber（import 失败）或 `apply` 抛错  | 红色徽标 + 错误              |
  | 未安装   | 目录不存在                                          | **不显示**（不是第五种开关） |

- **状态来源**：`entry.fiber.state` 与 `entry.disabled` 是唯一事实，内核只做映射
  （`applyFiberState`）。状态变化来自 fiber 的 `internal/status`，不靠轮询。
- **清单依赖**（`dependencies`）与 **服务依赖**（`inject`）分工明确：前者是「必须一起运行的
  插件」，激活前做图校验（缺失 / 自依赖 / 环），有问题直接 `dependencyIssues`；后者是
  「等某服务就绪」，运行期用 `waitingFor` 表达。
- **禁用**（`ctx.plugins.disable(id)`）：改 entry 的 `disabled` 并卸载 fiber，Include 写回文件；
  之后导航、命令、主题、布局与样式一并移除，只有 `enable(id)` 能解除。
- **启用 / 重载 / 卸载**：启用把 entry 的 `disabled` 置回 false；重载用
  `remove + create`（换查询串强制重新 import）；卸载删文件后 `rescan` 会让
  reconcile 把 entry 从树里移除。三者都不需要重启应用。
- `core: true` 的内核插件与 `essential: true` 的必需插件拒绝禁用（renderer 与 kernel 两侧都会校验）；
  这两个标记只对**内置插件**生效，第三方插件写它们不会获得自锁能力。插件管理自身标记为
  essential，避免禁用后失去恢复入口；日志与通知只通过事件被消费，不提供服务，因此不标记
  essential，可以随时禁用。
- 第三方插件的安装、升级、启用、禁用、重载与卸载规则见
  [plugin-manager.md](plugin-manager.md)。

## 11. 用户数据与实例布局

### 用户数据根

`app.getPath('userData')`（Windows 上是 `%APPDATA%\Mics\`，目录名由 `productName` 决定）
是唯一的可写根：

| 目录                    | 内容                                                                                           | 归属                               |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| `.minecraft/`           | 游戏根，结构对齐原版启动器：`versions/`、`libraries/`、`assets/`，见下                         | 原版游戏插件（写）/ 启动管线（读） |
| `cache/downloads/`      | 按 URL / sha1 复用的下载缓存；大文件分段的断点状态以 `.part.segments.json` 与 `.part` 相邻存放 | 下载管线                           |
| `mods/`                 | Mod 内容库：`<sha1>.jar` 实体；实例的 `mods/*.jar` 是指向这里的硬链接                          | Mod 内容库插件                     |
| `plugins/`              | 第三方插件本体                                                                                 | 插件管理                           |
| `logs/`                 | 每次启动一个 `mics-<时间>.log`                                                                 | 日志插件                           |
| `profiles/`             | `boot.config.json` 指向的 profile                                                              | 内核                               |
| `cordis.yml`            | 插件树：每个主进程插件的入口、配置与 `disabled`（Include 写回）                                | 内核（Include）                    |
| `disabled-plugins.json` | 纯渲染插件（没有主进程入口）的开关；其余开关已并入 `cordis.yml`                                | 内核                               |
| `enabled-plugins.json`  | 用户显式启用的「默认关闭」插件；没有记录时按清单的 `defaultDisabled` 处理                      | 内核                               |

游戏数据与应用数据分开放：`.minecraft` 可以整目录备份或搬到别的盘，而 `plugins` /
`logs` / `profiles` / `cache` 是启动器自己的东西。插件在根下新增目录前先确认没有
其它归属方，避免两个插件写同一路径。

### Mod 内容库

`mics.mods.store` 把实例里的 Mod 实体集中到 `<userData>/mods/<sha1>.jar`，实例的
`mods/` 里只留一条硬链接：同一个文件装进多个实例只占一份磁盘。它是可禁用的普通插件，
两条约定：

- **只在支持硬链接的卷上启用**：启动时在库存目录探测一次，FAT32 / 网络盘 / 权限不足
  时整体退回普通文件；运行期的 `EXDEV` / `ENOTSUP` 等也会永久退回，单次失败（并发、
  文件锁）只放弃当前文件。
- **不改变启用 / 禁用的语义**：开关仍然只是重命名（`foo.jar` ↔ `foo.jar.disabled`）。
  硬链接是独立的目录项，重命名只动实例里的那一条，库存实体与其它实例都不受影响；
  删除 Mod 后按 `nlink`（硬链接即引用计数）回收没有实例引用的实体。

它订阅下载管线的两个瀑布事件：`download/targets` 在任务登记前改写目标——同名但摘要
不同时给新文件加 `(摘要前 8 位)` 后缀，而不是覆盖实例里已有的版本；`download/commit`
在文件校验落盘后把实体搬进库存、在原位置建链接。两个事件的默认实现都是恒等操作，
禁用这个插件时下载行为与以前完全一致。

下载缓存仍然按 sha1 保留一份副本：第二个实例安装同一个 Mod 时直接命中缓存，不必
重新下载；缓存条目与库存实体互相独立，清理缓存不会影响已经建好的链接。

下载管线的单文件传输默认一条 HTTP 连接；「下载设置 → 大文件分段」可对达到分段阈值
的文件启用多条 Range 连接（阈值与连接数都在设置页按数字填写，默认 1 MB / 8 条，
1 条即关闭分段）。
传输层先探测 `bytes=0-0`，只有服务端返回 206 与有效 `Content-Range` 时才分段；
否则自动回退单连接。分段进度写在 `.part.segments.json`，暂停、失败与应用重启后
都能按段续传。

下载缓存上限在设置页按 **MB** 配置（默认 5102 MB，可输入任意正整数），也可以
选择「不缓存」或「无限制」。超过上限时按文件 mtime 淘汰最旧条目，命中缓存会刷新
mtime；`.part` / `.part.segments.json` 属于在途传输，不计入占用也永不淘汰；正在
复制或解析的缓存文件会被临时 pin 住。旧版本以 GB 保存的上限会在启动时一次性迁移。

### 实例布局

实例目录就是启动时传给游戏的游戏目录（`game_directory`），**同时就是版本目录**：
一个实例只有一次安装、一个加载器，所以容器里直接放实例目录，不再按版本 id 分层。
容器与库、资源一起放在 `.minecraft` 下，与 PCL 的层级一一对应：

```
%APPDATA%\Mics\                             ← 用户数据根（应用自己的数据）
└─ .minecraft\                              ← 游戏根（相当于 PCL 的 .minecraft）
   ├─ versions\<实例名>\                     ← 游戏目录 + 版本目录
   │  ├─ <版本 id>.json                     版本档案
   │  ├─ <版本 id>.jar                      客户端（纹理在 jar 里）
   │  ├─ natives\  log_configs\             本地库与日志配置
   │  ├─ instance.json  install-state.json  元数据与安装状态
   │  └─ mods\  logs\  saves\  options.txt   游戏自己写
   ├─ libraries\                            共享库（maven 坐标寻址）
   └─ assets\
      ├─ indexes\                           每个资源版本一份索引
      └─ objects\                           内容哈希寻址的资源对象
```

约定：

- **实例名就是文件夹名**，也是实例的唯一 id。合法性由 `@mics/sdk` 的
  `validateInstanceName` 定义，渲染进程（即时提示）与主进程（写盘把关）共用一份规则。
- **`versions/` 下的每个文件夹都是一个实例**：下载中断、还没有版本档案的半成品
  也会出现在启动页（标记为不完整，只能补全或删除）；只有存在版本档案且
  `install-state.json` 为 `ready` 时才提供启动入口。
- **实例根同时是游戏目录与版本目录**：版本档案与客户端 jar 平铺在根下，命名为
  `<版本 id>.json` / `<版本 id>.jar`。实例内部不要再套一层 `.minecraft` 或
  `versions/<版本 id>`；删除、备份、迁移都只动这一个目录，插件也不该在实例根之外
  写「属于这个实例」的文件。
- **版本 id 与实例名解耦**：文件名用 Mojang / 加载器给的版本 id，实例名由用户决定；
  改实例名不需要动版本文件，两者也不互相牵制合法字符集。
- **`natives` 与 `log_configs` 在实例根**：同一实例的多次启动共用一个 `natives`，
  启动时按目录清理不再需要的 DLL。
- **隔离方式固定为「按实例隔离」**，界面上不再提供「共享游戏目录」之类的选项：
  每个实例有自己的游戏目录，`.minecraft` 下的共享层只放与版本无关的资源。
- **一个实例 = 一次安装 = 一个加载器**。安装入口只接受尚不存在的实例名
  （`checkInstanceName`），没有「原地换加载器 / 追加版本」的接口。
- **整合包是「先解析、再按原版安装」**：归档下载到 `cache/downloads`，解析
  `modrinth.index.json` / `manifest.json` 后得到游戏版本、加载器与包内文件；游戏文件
  与包内文件进入同一个下载队列。`overrides/` 先解压到实例内的临时目录，等所有任务
  完成后再合并进实例根（跳过 `instance.json` / `install-state.json` / 版本档案），
  这样同名覆盖文件不会被下载结果反过来覆盖。

### 为什么实例里没有 `versions/<版本 id>/` 这一层

原版把版本放在 `.minecraft/versions/<版本>/`，是因为一个启动器目录要容纳多个版本，
版本目录是「多选一」的容器。本项目一个实例只有一次安装、一个加载器，这层容器没有
承载任何东西，所以实例根直接就是版本目录——这正是 PCL 开启版本隔离后的形态
（`versions/<版本>/` 既是版本目录又是游戏目录），只是名字换成了实例名。容器目录
本身仍叫 `versions`，与 PCL 的层级一一对应。

代价有两处，都在安装阶段消化：

- **Forge / NeoForge 安装器要求「类 `.minecraft`」的目标目录**（`versions/`、
  `libraries/`、`launcher_profiles.json`）。实例根不是这个形状，因此安装器跑在
  实例内的 `.installer` 暂存目录里，装完把版本档案与客户端 jar 搬进实例根、库并入
  共享库目录，暂存目录整体删除；安装器 jar 与日志放在 `.loader`，同样在结束后清掉。
- **实例目录不是原版的版本目录形状**：文件夹名是实例名而不是版本 id，里面还混着
  `mods` / `saves` 与安装元数据，因此不能把 `.minecraft` 直接交给原版启动器或按原版
  布局导入导出。需要时应当走一次显式转换（当前没有实现）。

### 共享层为什么不冲突

`libraries` 和 `assets` 都按「内容」而不是「版本」寻址，所以并存不会互相覆盖：

- `assets/objects` 的文件名就是内容的 SHA-1。两个版本里的同一个逻辑资源内容不同，
  就是两个不同文件名，各自保留；内容相同则天然只存一份。版本只通过
  `assets/indexes/<资源版本>.json` 引用自己需要的子集。
- `libraries` 按 maven 坐标（含版本号）分目录。需要同一个坐标就是同一个不可变构件，
  共享是正确行为；需要不同版本走不同路径。

真正可能撞车的只有「同名但内容可变」的两处：

- **并发安装**：两个实例同时装同一版本会写同一批共享路径（`.part` 也是同一份）。
  落盘前一律按 sha1 校验，校验不过的任务失败并可重试，不会被静默当成已下载；
  下载开始前还会先检查目标文件是否已存在且摘要一致，另一个实例装过的文件直接复用。
- **非标准 jar**：整合包若往同一坐标塞了不同内容，校验会发现不一致并进补全流程。

删除实例只删实例目录，共享文件不回收——与 PCL 删版本不删库一致；共享层的磁盘占用
因此只增不减，需要清理时应当作独立功能（引用计数或孤儿扫描），不要塞进删除流程。

### 与原版 / PCL 的对照

|                        | 原版启动器 / PCL                       | 本项目                            |
| ---------------------- | -------------------------------------- | --------------------------------- |
| 身份的键               | 版本名，`versions/<版本名>` 天然唯一   | 实例名，同一版本可以有多个实例    |
| 版本档案               | `.minecraft/versions/<版本>/`          | 实例根，`<版本 id>.json` + `.jar` |
| 游戏目录               | `.minecraft`（隔离时是版本目录本身）   | 实例根（同时是版本目录）          |
| `libraries` / `assets` | `.minecraft` 根一份，所有版本共享      | 用户数据根一份，所有实例共享      |
| 纹理                   | 在各自的 `client.jar` 里，跨版本不共享 | 同左                              |

一句话：**PCL 的版本隔离形态，把共享层再上提一级**——版本目录就是游戏目录，而
`libraries` / `assets` 不随实例走。同一版本装第二个实例时，只有版本 json、客户端
jar 与 `natives` 会重新落盘，资源对象和库直接复用。

## 12. 路线图

| 阶段 | 内容                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| M0   | 当前骨架：双端 Cordis、内核服务、导航贡献点、懒激活、示例页面、构建脚本          |
| M1   | 插件依赖图校验（已落地）、错误隔离面板、命令快捷键自定义、配置贡献点（带持久化） |
| M2   | 下载源与安装管线、实例管理、工作台布局可扩展（多面板/分栏）                      |
| M3   | 渲染端沙箱、性能追踪                                                             |
| M4   | electron-builder 打包、插件作为 extraResources                                   |

> 热插拔（安装 / 启用 / 禁用 / 重载 / 卸载，含卸载脚本）已在 M0 之后落地，
> 见 [plugin-manager.md](plugin-manager.md)。
