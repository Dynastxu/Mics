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
│   ├─ PluginsService     清单 → fiber 的映射、懒激活、依赖顺序                │
│   ├─ IpcService         mics:rpc 路由、mics:event 广播、调用方追踪           │
│   ├─ CommandsService    声明式命令 + 实现注册，执行前按需激活                │
│   ├─ StorageService     按 pluginId 隔离的 JSON 存储                        │
│   └─ PermissionsService 清单权限校验                                        │
│   └─ 其余插件由 PluginsService 逐个 ctx.plugin() 挂载                        │
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

| Cordis 概念 | 在本项目中的职责 |
| --- | --- |
| `Context` | 一切服务的容器；渲染进程也有一棵独立的 Context 树 |
| `ctx.plugin(plugin, config)` | 插件激活；返回 `Fiber`，await 即等待激活完成 |
| `ctx.effect(() => cleanup)` | 注册页面/命令/IPC 时的回收钩子；插件卸载自动执行 |
| `ctx.inject(deps, cb)` | 依赖多个服务后再执行（内核注册系统 RPC 时用到）；服务缺失时插件停在 waiting |
| `ctx.waterfall('ipc/before', …)` | RPC 派发前的拦截链：权限、审计、二次确认挂在插件侧，内核不再逐条加 if |
| `Service` 子类 | 内核能力：`plugins` / `ipc` / `commands` / `storage` / `permissions` / `capabilities` / `configuration`；插件也能提供（`mics.logger` → `ctx.logs`） |
| `ctx.isolate()` | 后续用于单插件服务隔离（例如独立日志命名空间） |
| `ctx.on/emit` | 主进程内部事件；每个 Mics 事件在 `@mics/sdk` 的 `EVENT_MODES` 里声明派发模式，见下文「事件派发模式」 |
| `ctx.registry` | 插件面板可据此列出所有 fiber（后续扩展点） |

### 事件派发模式

cordis 4 提供五种派发模式，Mics 的每个事件都必须先登记模式再派发：

| 模式 | 语义 | 当前事件 |
| --- | --- | --- |
| `emit` | 通知，同步执行，返回值丢弃 | `plugins/changed`、`plugin/activated`、`plugin/deactivated`、`ipc/after`、`capability/changed` |
| `bail` | 同步投票，第一个非空返回值即结论 | `plugin/beforeActivate`（审批：`{ allow: false, reason }` 拒绝激活） |
| `waterfall` | 中间件，监听器拿到 `next()`，可短路或改写 | `ipc/before`（权限、审计、限流、二次确认） |
| `serial` | 串行等待，遇到第一个结论即停止 | 暂无（需要异步审批时使用） |
| `parallel` | 扇出，等全部监听器完成 | 暂无（纯并行的收尾工作使用） |

声明集中在 `packages/sdk/src/contract/events.ts`：

- `MicsEvents` 定义事件签名，`EVENT_MODES` 记录模式；新增事件却忘记登记模式会编译失败；
- 派发方用 `emitEvent` / `bailEvent` / `waterfallEvent` / `serialEvent` / `parallelEvent`，
  事件名与模式不匹配是编译错误；
- 开发模式下 `plugins/kernel/src/eventModeAudit.ts` 监听 `internal/dispatch`，
  实际派发模式与声明不符时打 warning；生产构建不挂这个审计。

这样「`emit` 之后有没有人改返回值」不需要读派发点猜，类型和声明会直接回答。

### 调用方追踪（traceable）

Cordis 的 Service 方法在被插件调用时，`this.ctx` 会指向**调用方插件的作用域**。因此：

- `ctx.storage.get('k')` 自动落到调用方插件自己的 JSON 文件；
- `ctx.ipc.handle('x', fn)` 自动登记到调用方插件 id 下，并在其卸载时移除；
- `ctx.ui.registerView(...)` 注册的页面会随插件 fiber dispose 一起消失。

这就是为什么插件里不需要手写 `pluginId` 参数。

> 注意：插件 id 存在 `PLUGIN_ID` 这个 **Symbol 键**上，用 `pluginIdOf(ctx)` 读取。
> 不能写成 `ctx.pluginId`——cordis 的 Context 代理会把未注册的字符串属性当作服务解析，
> 在没有该服务的上下文里会抛 `cannot get property "pluginId" without inject`。
>
> 同理，**从插件上下文访问任何服务都必须在 `inject` 里声明**。内核/渲染器的服务内部
> 在需要访问兄弟服务时，一律使用自己构造时的上下文（`owner`），而不是被追踪到调用方的
> `this.ctx`——调用方未必声明了那个 inject。
>
> 插件也能提供 Service：`mics.logger` 在启动时提供 `ctx.logs`，按启动把日志写入文件。
> 服务名与插件 id 一样是全局契约，其它插件用 `inject: ['logs']` 获取；提供方卸载时
> cordis 会等待依赖方先释放，因此日志插件标记为 `essential`，避免禁用后让依赖它的
> 插件停在未激活状态。日志插件通常不是第一个激活的：cordis LoggerService 自带
> 滚动缓冲区，日志插件激活时先补录启动阶段的消息，再接管 `ctx.logger` 的导出；
> 渲染进程没有文件系统权限，经 `mics.logger/log/write` 把日志汇总到同一文件。

### 能力（capability）：definition / provider / consumer

Service 是「一个名字一个实现」，而有些能力需要**多份实现**（本机 / 沙箱 / 远程）。
这类能力走 `ctx.capabilities`：

| 角色 | 位置 | 例子 |
| --- | --- | --- |
| definition | `@mics/sdk` 的 `capability.ts`：能力名 + 接口 | `SHELL_EXECUTE` / `FileTransferCapability` |
| provider | 插件在 `apply()` 里 `ctx.capabilities.provide(name, impl, { priority })` | `mics.shell` 提供本机进程，`download-manager` 提供本机传输 |
| consumer | `ctx.capabilities.require(name)` | `mics.launch` 启动游戏、下载管线传输文件 |

选择规则是「priority 高的赢，同优先级后注册的赢」。因此沙箱插件只要注册同名能力并给
更高 priority，就能整体替换执行方式，调用方一行不用改。`provide()` 绑定在提供方 fiber
上，插件卸载时实现自动撤销并广播 `capability/changed`。

与 Service 的分工：**能力名是契约，Service 名是实现入口**。需要「换实现」的用能力，
需要「拿运行时服务」的（storage / ipc / logs）继续用 inject。

### 配置 schema 与 profile

`ctx.storage` 不再只是裸 JSON：清单声明 `contributes.configuration` 后，`StorageService`
按 schema 做「用户值 → profile 默认 → schema 默认」的取值与写入校验。schema 由
`ConfigurationService` 持有（从 `PluginsService` 的清单实时读取），因此热重载后立刻生效，
插件代码仍然只需要 `ctx.storage.get/set`。

- 设置界面：插件管理页的插件详情通过 `configuration/list|set|reset` 渲染简单类型；
  设置项多或需要专门界面的插件用 `settingsView` 指向自己的页面，详情里只给入口，
  双方共享同一套 schema 校验。
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
             ├─ 日志出口接入 mics.logger/log/write（渲染端日志写进同一个文件）
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
- 插件可以调用 `ctx.ui.navigate(viewId)` 切到任意已注册页面（例如安装受理后跳到下载进度）；
  目标页面不存在（插件缺失或被禁用）时返回 `false`，由调用方决定如何提示。

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

| 关注点 | 实现 |
| --- | --- |
| 系统菜单 | bootstrap 里 `Menu.setApplicationMenu(null)`；开发/预览构建下用 F12（或 `Ctrl+Shift+I`）开 DevTools、`Ctrl+R` 重载渲染进程 |
| 标题栏 | `shell/WindowTitleBar.vue`；拖动区用 `-webkit-app-region: drag` 交给系统，双击最大化、贴边吸附都是系统行为 |
| 窗口按钮 | 按钮区 `-webkit-app-region: no-drag`，点击经 `window.mics.windowControls` → IPC → 主进程 `BrowserWindow` |
| 最大化状态 | 主进程监听 `maximize` / `unmaximize` 推给渲染进程，标题栏据此在「最大化 / 还原」之间切换图标 |
| 窗口尺寸 | `main/windowSizing.ts`：最小 640×420，启动尺寸不超过当前工作区；状态栏「命令」右侧有一个拖动区，按住拖动即可缩放窗口（左上角固定，只受最小尺寸限制） |

壳专用的 IPC 通道：

- `mics:window-control`：渲染 → 主，`minimize` / `toggle-maximize` / `close`；
  主进程用 `BrowserWindow.fromWebContents(event.sender)` 只操作发消息的那个窗口。
- `mics:window-resize`：渲染 → 主，`{ phase: 'start' | 'move' | 'end', x, y }`；
  指针用屏幕坐标，主进程以按下时的 bounds 加上位移算出新宽高，左上角保持不动，
  只夹最小尺寸；最大化时先还原再继续。
- `mics:window-state`：主 → 渲染，`{ maximized }`；渲染进程挂载时再 `invoke` 拉一次，
  因为窗口重载时状态事件可能早于监听。

窗口装饰和导航容器、状态栏一样属于外壳，不作为插件贡献点。

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

下载页里的「筛选按钮 / 筛选面板 / 通用列表」是跨页面的通用件，独立成
`packages/ui`（`@mics/ui`）：

| 组件 | 职责 |
| --- | --- |
| `FilterButton` | 漏斗按钮 + 非默认筛选圆点，`v-model:open` 控制面板 |
| `FilterPanel` | 按 `FilterGroup[]` 渲染分组胶囊；`single` 单选、`multi` 多选，`exclusive` 选项（「全部」）与其它互斥 |
| `DataList` | 通用行渲染（主文本 + 徽标 + 次要文本）；`role="button"` 整行进入，`role="radio"` 单选并显示勾，`role="static"` 仅展示；`#row` 插槽自定义行 |
| `DataBrowser` | 搜索 + 筛选 + 计数标题 + `DataList`；内部持有查询与筛选状态，调用方只给 `items` 与 `@select` |
| `ToggleSwitch` | 开关按钮，`v-model` 布尔值；用 `role="switch"` 与 `aria-checked` 表达状态 |

为什么是包而不是「组件插件」：插件各自独立打包，运行时组件注册表拿不到 props 类型，
也保证不了加载顺序；静态引入让编译期就能校验，每个插件也只打包用到的组件。
组件复用 shell 的 `mics-*` 设计系统类，自带的 scoped 样式会进插件的 `dist/style.css`，
因此使用方必须在 `plugin.json` 里声明 `styles`。

## 10. 懒激活、状态机与贡献点

- `activation: ["*"] | ["onStartup"]`：随内核启动。
- 缺省：按需。打开页面时激活，或执行命令时由命令服务按 manifest 找到归属插件后激活。
- 渲染器先按清单渲染导航 / 状态栏 / 主题；插件被激活时才 import 产物、创建 fiber、注册页面组件。
- 渲染端插件激活时也会同步内核状态（`plugins/activate`），保持主进程与渲染进程的生命周期一致。
- **状态机**（目录是「已安装」的唯一事实来源）：

  | 状态 | 含义 | 界面 |
  | --- | --- | --- |
  | 启用 | 目录在、fiber active | 开关打开 |
  | 等待依赖 | 目录在、fiber pending：`inject` 的服务没人提供 | 徽标「等待依赖」+ 缺哪些服务 |
  | 禁用 | 目录在、代码停止，状态写入 `userData/disabled-plugins.json` | 开关关闭 |
  | 失败 | 目录在、导入或 `apply` 抛错 | 红色徽标 + 错误 |
  | 未安装 | 目录不存在 | **不显示**（不是第五种开关） |

- **三种状态与 waiting 的区别**：`PluginStatus` 里 `waiting` 不是安装状态，而是「插件已挂载、
  但 `inject` 的服务没出现」。cordis 在服务缺失时只会把 fiber 留在 pending，`ctx.plugin()`
  仍然 resolve——所以内核自己把 `fiber.state` 映射成插件状态（`plugins.ts` 的
  `applyFiberState`），服务出现 / 消失时自动更新。
- **清单依赖**（`dependencies`）与 **服务依赖**（`inject`）分工明确：前者是「必须一起运行的
  插件」，激活前做图校验（缺失 / 自依赖 / 环），有问题直接 `dependencyIssues`；后者是
  「等某服务就绪」，运行期用 `waitingFor` 表达。两者混用会让「装错了」和「还没就绪」
  看起来一样。
- **禁用**（`ctx.plugins.disable(id)`）：写入状态文件并卸载 fiber；之后页面打开、命令执行、
  启动事件都不会再激活它，只有 `enable(id)` 能解除。禁用后不再贡献导航 / 命令 / 主题 /
  布局 / 状态栏与样式。
- **启用 / 重载 / 卸载**都是双进程事务：主进程 fiber 与渲染端 fiber 一起成功或一起失败；
  渲染端加载失败会回报内核（`plugins/fail`），内核停下主进程并标记失败。
- `core: true` 的内核插件与 `essential: true` 的必需插件拒绝禁用（renderer 与 kernel 两侧都会校验）；
  这两个标记只对**内置插件**生效，第三方插件写它们不会获得自锁能力。插件管理自身标记为
  essential，避免禁用后失去恢复入口；日志插件同样标记为 essential，避免禁用后让 inject
  `logs` 的插件停在未激活状态。
- 第三方插件的安装、升级、启用、禁用、重载与卸载规则见
  [plugin-manager.md](plugin-manager.md)。

## 11. 用户数据与实例布局

### 用户数据根

`app.getPath('userData')`（Windows 上是 `%APPDATA%\Mics\`，目录名由 `productName` 决定）
是唯一的可写根：

| 目录 | 内容 | 归属 |
| --- | --- | --- |
| `.minecraft/` | 游戏根，结构对齐原版启动器：`versions/`、`libraries/`、`assets/`，见下 | 下载管线（写）/ 启动管线（读） |
| `cache/downloads/` | 按 URL / sha1 复用的下载缓存 | 下载管线 |
| `plugins/` | 第三方插件本体 | 插件管理 |
| `logs/` | 每次启动一个 `mics-<时间>.log` | 日志插件 |
| `profiles/` | `boot.config.json` 指向的 profile | 内核 |
| `disabled-plugins.json`、各插件 JSON | 插件开关与 `ctx.storage` 数据 | 内核 / 各插件 |

游戏数据与应用数据分开放：`.minecraft` 可以整目录备份或搬到别的盘，而 `plugins` /
`logs` / `profiles` / `cache` 是启动器自己的东西。插件在根下新增目录前先确认没有
其它归属方，避免两个插件写同一路径。

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

| | 原版启动器 / PCL | 本项目 |
| --- | --- | --- |
| 身份的键 | 版本名，`versions/<版本名>` 天然唯一 | 实例名，同一版本可以有多个实例 |
| 版本档案 | `.minecraft/versions/<版本>/` | 实例根，`<版本 id>.json` + `.jar` |
| 游戏目录 | `.minecraft`（隔离时是版本目录本身） | 实例根（同时是版本目录） |
| `libraries` / `assets` | `.minecraft` 根一份，所有版本共享 | 用户数据根一份，所有实例共享 |
| 纹理 | 在各自的 `client.jar` 里，跨版本不共享 | 同左 |

一句话：**PCL 的版本隔离形态，把共享层再上提一级**——版本目录就是游戏目录，而
`libraries` / `assets` 不随实例走。同一版本装第二个实例时，只有版本 json、客户端
jar 与 `natives` 会重新落盘，资源对象和库直接复用。

## 12. 路线图

| 阶段 | 内容 |
| --- | --- |
| M0 | 当前骨架：双端 Cordis、内核服务、导航贡献点、懒激活、示例页面、构建脚本 |
| M1 | 插件依赖图校验（已落地）、错误隔离面板、命令快捷键自定义、配置贡献点（带持久化） |
| M2 | 下载源与安装管线、实例管理、工作台布局可扩展（多面板/分栏） |
| M3 | 渲染端沙箱、性能追踪 |
| M4 | electron-builder 打包、插件作为 extraResources |

> 热插拔（安装 / 启用 / 禁用 / 重载 / 卸载，含卸载脚本）已在 M0 之后落地，
> 见 [plugin-manager.md](plugin-manager.md)。
