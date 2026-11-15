# 服务器状态（`mics.server-status`）

主进程 + 页面插件。左侧导航「服务器状态」列出任意 Minecraft 服务器的在线人数、
版本与 MOTD，数据经 [node-mcstatus](https://www.npmjs.com/package/node-mcstatus)
调用 [mcstatus.io](https://mcstatus.io/docs) 公开 API。

## 默认列表与删除

首次启用时写入两台内置服务器：

| 名称    | 地址           |
| ------- | -------------- |
| Hypixel | mc.hypixel.net |
| 2b2t    | 2b2t.org       |

内置服务器只是**初始数据**，与用户添加的服务器没有区别，可以直接删除；删光之后
`servers` 键仍然存在（空数组），重启不会再把它们写回来。要恢复默认列表，删除
`<userData>/plugin-storage/mics.server-status.json` 里的 `servers` 键即可。

## 查询行为

- **只有这两条路由**：Java 版走 `statusJava`，基岩版走 `statusBedrock`，都带
  `baseURL`（配置里的「API 根地址」）；Java 版固定 `query: false`——插件不展示
  query 才有的插件/软件信息，关掉它可以少等约 1 秒。
- **限流**：mcstatus.io 按 IP 限制 5 次/秒。所有请求在主进程排队，两次请求至少
  间隔 240ms；同一台服务器的并发查询合并成一次。
- **缓存**：查询结果在主进程缓存至少 10 秒（同时尊重接口返回的 `expires_at`）。
  页面切换、重新打开都不会重复发请求；手动刷新与自动刷新带 `force` 时才会真正
  重新查询。
- **只传可序列化数据**：服务端返回的 HTML 不进入页面，只传纯文本 MOTD 行与
  校验过的 `data:image/*;base64` 图标。
- **离线与失败分开**：接口正常返回 `online: false` 是「离线」；接口本身不可用、
  限流或地址无法解析时，卡片显示「查询失败」与原因。

## 设置

| 键               | 默认值                       | 说明                                    |
| ---------------- | ---------------------------- | --------------------------------------- |
| `apiBaseUrl`     | `https://api.mcstatus.io/v2` | 部署相关：自建 mcstatus 实例或代理时改  |
| `refreshSeconds` | `60`                         | 页面**可见时**的自动刷新间隔（15–3600） |

设置页在「插件管理 → 服务器状态」里直接渲染（`contributes.configuration`）；
页面本身只读这两项，写入统一走 `configuration/set`，一次写入两侧同时生效。

自动刷新只在页面可见时进行：页面在页面栈里常驻，切到其它页面后
`checkVisibility` 为 false，不再产生请求。

## RPC

```ts
// 列表：添加 / 删除也返回整份列表
await ctx.ipc.invoke('mics.server-status', 'servers/list')

// 添加：地址支持 host 与 host:port，port 缺省按版本取 25565 / 19132
await ctx.ipc.invoke('mics.server-status', 'servers/add', {
  address: 'play.example.com:25566',
  label: '示例服',
  edition: 'java' // 'java' | 'bedrock'
})

// 删除
await ctx.ipc.invoke('mics.server-status', 'servers/remove', { id: '<entry id>' })

// 查询：ids 缺省查全部，force 跳过缓存
const statuses = await ctx.ipc.invoke('mics.server-status', 'servers/status', {
  ids: ['hypixel'],
  force: true
})

// 当前设置（页面自用；写入走内核的 configuration/set）
await ctx.ipc.invoke('mics.server-status', 'settings/read')
```

`servers/status` 返回 `ServerStatus[]`，形状见 `src/shared.ts`。单台失败只影响
那一台，其它服务器照常返回。

## 存储

`<userData>/plugin-storage/mics.server-status.json`：

- `servers`：`{ id, host, port, edition, label }[]`，没有 schema，由本插件校验；
- `apiBaseUrl` / `refreshSeconds`：与清单里的配置 schema 同一份，带校验。

## 构建

`node-mcstatus` 是 CommonJS 库，带 `package.json` 的插件在构建时会把整棵依赖树
内联进 `dist/main.mjs`（见 `scripts/build-plugins.mjs`），因此插件目录离开仓库
`node_modules` 也能单独运行。
