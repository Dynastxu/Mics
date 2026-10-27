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
| `ctx.inject(deps, cb)` | 依赖多个服务后再执行（内核注册系统 RPC 时用到） |
| `Service` 子类 | 内核能力：`plugins` / `ipc` / `commands` / `storage` / `permissions` |
| `ctx.isolate()` | 后续用于单插件服务隔离（例如独立日志命名空间） |
| `ctx.on/emit` | 主进程内部事件；跨进程事件走 `ctx.ipc` |
| `ctx.registry` | 插件面板可据此列出所有 fiber（后续扩展点） |

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

## 3. 启动时序

```
app.whenReady()
  ├─ scanPlugins(pluginRoots)            # 读取所有 plugin.json
  ├─ registerPluginProtocol(records)     # mics-plugin://<id>/<path>
  ├─ new Context()
  ├─ root.extend({ [PLUGIN_ID]: 'mics.kernel' }).plugin(kernel, config)
  │    ├─ 内核注册 plugins/ipc/commands/storage/permissions 服务
  │    ├─ 注入完成后注册系统 RPC
  │    └─ activateStartup()（不阻塞）
  ├─ createMainWindow()
  └─ loadRenderer(window)
        └─ 渲染进程 boot()
             ├─ 创建渲染器 Context，注册 bridge/ipc/commands/ui/theme/plugins
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

## 6. 窗口与自绘标题栏

窗口是无边框的（`frame: false`），系统标题栏、菜单栏、窗口按钮都不显示：

| 关注点 | 实现 |
| --- | --- |
| 系统菜单 | bootstrap 里 `Menu.setApplicationMenu(null)`；开发/预览构建下用 F12（或 `Ctrl+Shift+I`）开 DevTools、`Ctrl+R` 重载渲染进程 |
| 标题栏 | `shell/WindowTitleBar.vue`；拖动区用 `-webkit-app-region: drag` 交给系统，双击最大化、贴边吸附都是系统行为 |
| 窗口按钮 | 按钮区 `-webkit-app-region: no-drag`，点击经 `window.mics.windowControls` → IPC → 主进程 `BrowserWindow` |
| 最大化状态 | 主进程监听 `maximize` / `unmaximize` 推给渲染进程，标题栏据此在「最大化 / 还原」之间切换图标 |

壳专用的 IPC 通道：

- `mics:window-control`：渲染 → 主，`minimize` / `toggle-maximize` / `close`；
  主进程用 `BrowserWindow.fromWebContents(event.sender)` 只操作发消息的那个窗口。
- `mics:window-state`：主 → 渲染，`{ maximized }`；渲染进程挂载时再 `invoke` 拉一次，
  因为窗口重载时状态事件可能早于监听。

窗口装饰和导航容器、状态栏一样属于外壳，不作为插件贡献点。

## 7. 信任与权限模型（当前阶段）

- **主进程插件**：拥有完整 Node 能力，清单里的 `permissions` 用于声明与审计。
- **渲染进程插件**：与 shell 共享页面，属于「可信插件」模型；清单权限由宿主服务
  （如 `host/openExternal`）在调用时校验。
- 真正的渲染端沙箱（iframe / utility process / per-plugin JS 隔离）在路线图 M3。

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
| `DataList` | 通用行渲染（主文本 + 徽标 + 次要文本）；`role="button"` 整行进入，`role="radio"` 单选并显示勾；`#row` 插槽自定义行 |
| `DataBrowser` | 搜索 + 筛选 + 计数标题 + `DataList`；内部持有查询与筛选状态，调用方只给 `items` 与 `@select` |

为什么是包而不是「组件插件」：插件各自独立打包，运行时组件注册表拿不到 props 类型，
也保证不了加载顺序；静态引入让编译期就能校验，每个插件也只打包用到的组件。
组件复用 shell 的 `mics-*` 设计系统类，自带的 scoped 样式会进插件的 `dist/style.css`，
因此使用方必须在 `plugin.json` 里声明 `styles`。

## 10. 懒激活、禁用与贡献点

- `activation: ["*"] | ["onStartup"]`：随内核启动。
- 缺省：按需。打开页面时激活，或执行命令时由命令服务按 manifest 找到归属插件后激活。
- 渲染器先按清单渲染导航 / 状态栏 / 主题；插件被激活时才 import 产物、创建 fiber、注册页面组件。
- 渲染端插件激活时也会同步内核状态（`plugins/activate`），因此插件管理页看到的
  「已激活」与页面实际加载情况一致。
- **禁用**（`ctx.plugins.disable(id)`）：写入 `userData/disabled-plugins.json` 并卸载 fiber；
  之后页面打开、命令执行、启动事件都不会再激活它，只有 `enable(id)` 能解除。
  `core: true` 的内核插件拒绝禁用（renderer 与 kernel 两侧都会校验）。

## 11. 路线图

| 阶段 | 内容 |
| --- | --- |
| M0 | 当前骨架：双端 Cordis、内核服务、导航贡献点、懒激活、示例页面、构建脚本 |
| M1 | 插件依赖图校验、错误隔离面板、命令快捷键自定义、配置贡献点（带持久化） |
| M2 | 下载源与安装管线、实例管理、工作台布局可扩展（多面板/分栏） |
| M3 | 渲染端沙箱、插件热重载、性能追踪 |
| M4 | electron-builder 打包、插件作为 extraResources、独立插件目录 |
