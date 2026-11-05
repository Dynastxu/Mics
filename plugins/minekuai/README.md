# 麦块开放API（`mics.minekuai`）

主进程插件。按英文名称查询[麦块公共 API](https://bbs.minekuai.com/open-api)，在
Mod / 整合包 / 资源包 / 光影包 / 数据包目录里显示中文名称与描述。

清单标记为 `experimental` + `defaultDisabled`：首次出现默认关闭，在插件管理里
打开开关后生效。

## 匹配规则

1. 用目录条目的英文 `name` 作为 `q` 查询，`status=translated`，最多取
   `maxCandidates` 条候选（默认 5）。
2. 逐条比较候选的 `title` 与 `description_en`：去掉首尾空白后必须与来源原文
   **完全一致**。不做大小写、标点或相似度归一化。
3. 只有通过第 2 步的候选才会采用 `title_zh` / `description_zh`；某个中文字段为
   空时该字段保留原文（例如 Sodium 没有中文名，但简介有译文）。
4. 没有候选通过、查询超时或接口失败时，整条目录保留原文。翻译失败不会阻断
   目录打开。

## 事件

监听 `catalog/describe`（`waterfall`）。下载管线在主进程返回目录 RPC 之前派发，
缓存、搜索与指纹识别仍然只看到来源原文。

## RPC

```ts
// 原始查询：英文与中文并存的条目，不做匹配
await ctx.ipc.invoke('mics.minekuai', 'search', { kind: 'mod', query: 'Create' })

// 精确解析：英文不一致时返回原文
await ctx.ipc.invoke('mics.minekuai', 'resolve', {
  kind: 'mod',
  name: 'Create',
  summary: 'Aesthetic Technology that empowers the Player',
  projectId: 'LNytGWDc',
  slug: 'create',
  source: 'modrinth'
})

// 当前设置与缓存规模
await ctx.ipc.invoke('mics.minekuai', 'status')

// 清空查询与译文缓存（同时解除熔断，下一次请求重新探测）
await ctx.ipc.invoke('mics.minekuai', 'clear')
```

`kind` 取 `mod` / `modpack` / `resourcepack` / `shader` / `datapack`。

## 设置

| 键                | 默认                      | 说明                                     |
| ----------------- | ------------------------- | ---------------------------------------- |
| `enabled`         | `true`                    | 是否改写目录展示；关闭后仍可用 RPC 查询  |
| `baseUrl`         | `https://api.minekuai.cn` | API 根地址，自建代理时修改               |
| `timeoutMs`       | `5000`                    | 单次 HTTP 查询超时                       |
| `budgetMs`        | `3500`                    | 一批目录查询共享的等待预算，超时回退原文 |
| `cacheTtlMinutes` | `10`                      | 查询结果与译文的缓存时长                 |
| `maxCandidates`   | `5`                       | 每次查询最多比对多少条候选               |
| `concurrency`     | `6`                       | 同时发起的查询数                         |

## 限制

- 查询会把 Mod 的英文名称发送到麦块公共 API；不发送账号、实例路径或本地文件。
- 缓存只在内存里，插件重载或应用重启后重新查询。
- 麦块没有数据包独立端点，数据包沿用 `mc-mods` 查询；命中不了就回退原文。
- 实例 Mod 列表的名称来自 jar 内的 `fabric.mod.json` / `mods.toml`，不经过
  目录 RPC，因此不受本插件影响。
- CurseForge 条目的简介与麦块保存的英文若不逐字相同（标点、空格、改版），
  会按规则回退原文；这是有意的，避免展示过期译文。
