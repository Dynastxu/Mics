# 下载子系统

下载子系统按「传输」与「内容分析」拆开：**下载管线只负责把文件从候选源取回并校验**，
原版、加载器、社区来源、整合包与各类资源包各自是独立插件，通过事件把任务交给管线，
并在完成事件里做自己的收尾。

## 1. 插件分层

| 插件                                                 | 职责                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `mics.download.manager`                              | 下载管线：任务登记、并发调度、断点续传、SHA1 校验、缓存、暂停/取消/重试、进度与任务记录       |
| `mics.download.game`                                 | 原版：Mojang 版本清单 / 版本档案、实例目录与 `install-state.json`、新装与补全编排、原版下载源 |
| `mics.download.loaders`                              | 加载器注册表：路由版本查询与安装，聚合加载器源设置                                            |
| `mics.download.loader.fabric`                        | Fabric 版本列表与 profile 安装                                                                |
| `mics.download.loader.forge`                         | Forge 版本列表、安装器下载/运行、库合并                                                       |
| `mics.download.loader.neoforge`                      | NeoForge 版本列表、安装器下载/运行、库合并                                                    |
| `mics.download.catalog`                              | 社区目录：来源注册表、搜索合并、分页、缓存、`catalog/describe`                                |
| `mics.download.source.modrinth`                      | Modrinth API 与来源配置                                                                       |
| `mics.download.source.curseforge`                    | CurseForge API、Key、指纹、整合包文件解析                                                     |
| `mics.download.mod`                                  | Mod 页面 + 多实例安装                                                                         |
| `mics.download.modpack`                              | 整合包页面 + 归档解析/覆盖合并/安装编排                                                       |
| `mics.download.datapack` / `resourcepack` / `shader` | 对应页面 + 安装                                                                               |
| `mics.download`                                      | 下载分组、下载进度页、下载设置壳                                                              |
| `mics.download.vanilla`                              | 原版页面                                                                                      |

依赖方向：页面 → 游戏 / 目录；游戏与编排 → 管线；来源 → 目录；加载器 → 加载器注册表。
**游戏不依赖具体加载器**：禁用 Forge 插件只会让 Forge 版本列表为空，不会影响原版或 Fabric。

## 2. 管线契约（`download/*`）

```ts
interface DownloadFileRequest {
  label: string
  url: string
  savePath: string
  sha1?: string
  size?: number
  /** 从哪些源下载；按顺序回退，省略表示直链 */
  sources?: DownloadEndpoint[]
  guardDir?: string
}

interface DownloadEndpoint {
  id: string // 健康度键，例如 'mojang:0' / 'loader:fabric:1' / 'direct'
  label: string
  url: string
  category?: 'meta' | 'library' | 'asset' | 'loader' | 'file'
}
```

请求事件（`serial`）：

- `download/create`：建任务，返回 `jobId`；`autoFinish: true` 表示「文件完成即结算」
  （Mod / 资源包这类只落盘、不写实例状态的任务）。
- `download/addFiles`：追加一批文件，可多次调用。
- `download/awaitFiles`：等待指定文件进入终态（阶段依赖，例如安装器）。
- `download/seal`：声明「文件清单已提交完」；封口前即使当前批次全部完成也不结算。
- `download/data`：更新编排方私有状态（版本 id、overrides 暂存目录），管线原样持久化。
- `download/finish`：编排方收尾完成 / 失败。
- `download/retry`：管线先重排失败任务并返回 `true`；没有可重排任务时返回 `false`，
  由编排方重新分析。

通知事件（`emit`）：

- `download/started`、`download/report`、`download/fileFinished`
- `download/filesDone`：全部文件完成且已封口，编排方在这里收尾（合并覆盖文件、写 ready 标记）。
- `download/jobFinished`：`done` / `failed` / `cancelled`。
- `download/jobResumed`：应用重启后恢复未完成任务，编排方重新挂上收尾逻辑。
- `download/discarded`：任务记录被删除，编排方清理自己的暂存目录。

状态机：

```
preparing ──addFiles──▶ downloading ──filesDone──▶ finalizing ──finish(done)──▶ done
    │                       │                          │
    └─finish(failed)────────┴──cancel──▶ cancelled     └──finish(failed)──▶ failed
```

失败任务会保留逐文件明细，供 `install/retry` 重排；`done` / `cancelled` 才归档明细。

### 源尝试与自动重试

- 普通文件按 `sources` 顺序尝试，**每个源最多 3 次**；一个源用尽才换下一个源。
- 所有源都失败的文件标记为 `deferred`，等本轮其它文件结束后自动进入重试轮。
- 重试轮里失败文件数没有减少（或达到 3 轮上限）就停止，任务最终报失败。
- `race: true` 的文件（加载器安装器、客户端等）同时向所有源发起请求，每个源
  仍然最多试 3 次，谁先成功用谁。
- 不再有「某个源失败几次就全局冷却 5 分钟」的机制；冷却只作用于当前文件。

### 目标与落盘扩展点（`waterfall`）

- `download/targets`：在 `download/addFiles` 内部、登记任务之前派发。此时还没有任何
  字节落盘，监听器可以给同名文件让路（返回新的 `savePath`）；数组必须等长、下标对应，
  抛出的异常由管线吞掉并回退原清单。
- `download/commit`：`.part` 改名成目标文件、SHA1 校验通过后派发。监听器可以把实体
  搬进内容库并在原位置留一条硬链接，返回最终落点；管线按返回的 `path` 继续写缓存
  与取消清理。整合包合并覆盖文件时直接落盘、不经过管线，也派发同一事件，并且
  **先写临时文件再改名**——目标是硬链接时直接覆盖会写穿共享实体。

`mics.mods.store` 是这两个事件的消费者：Mod 实体集中存到 `<userData>/mods/<sha1>.jar`，
实例里只留硬链接，同名不同摘要按后缀并存；删除 Mod 后按硬链接数回收无引用实体。
细节见 [architecture.md](architecture.md) 的「Mod 内容库」。禁用该插件时两个事件没有
监听器，下载行为与未安装时完全一致。

## 3. 原版与加载器（`game/*`、`loader/*`）

- `game/prepareVersion`：取父版本 → 有加载器时派发 `loader/prepare` → 合并版本档案、改写 id、落盘。
- `game/collectFiles`：把版本档案展开成 `DownloadFileRequest[]`，每个文件带原版候选源。
- `game/beginInstall` / `completeInstall` / `discardInstall`：实例目录与安装状态只由游戏插件写。
- `loader/prepare`：加载器插件自己解析版本、下载安装器、运行 Java；文件下载走管线，
  原版客户端 jar 的候选源由 `LoaderPrepareInput.clientSources` 传入，避免直连 Mojang。

## 4. 社区目录（`catalog/*`）

`mics.download.catalog` 提供 `catalog` 注册表服务，来源插件实现 `CatalogSource` 并注册。
目录 RPC 保持 `mods/*` / `modpacks/*` / `packs/*` 命名，页面只换 target：

- `mods/sources|categories|search|versions|project|identify`
- `modpacks/...`
- `packs/...`（带 `kind`）
- `sources/get|set`：设置页读写来源配置

搜索由各来源返回「前 N 条 + 总数」，目录聚合后统一排序、切片；`catalog/describe`
仍然在 RPC 返回前改写展示文案。

## 5. 配置归属与迁移

| 配置                              | 归属                             |
| --------------------------------- | -------------------------------- |
| 并发 / 分段 / 分段阈值 / 缓存上限 | 下载管线                         |
| 原版下载源                        | 原版游戏插件                     |
| 加载器下载源                      | 各加载器插件（注册表聚合设置页） |
| Mod 下载源                        | 各来源插件（目录聚合设置页）     |

旧版下载插件保存的 `sources` / `loaderSources` / `modSources` 不删除：新插件启动时
通过只读事件 `download/legacy-config` 导入一次，然后写入各自的插件存储。

## 6. 新增一个来源 / 加载器

- 来源：新建插件，实现 `CatalogSource`，`ctx.catalog.register(source)`；声明依赖
  `mics.download.catalog`。不需要改目录插件或页面。
- 加载器：新建插件，实现 `LoaderProvider`，`ctx.loaders.register(provider)`；声明依赖
  `mics.download.loaders`。版本列表、安装器、库合并都在插件内；文件下载通过运行时完成。
