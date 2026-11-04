# HMR 探针（开发期验收）

这个插件没有业务功能，只做一件事：**模块每被重新求值一次，就打一条日志**。

```ts
const evaluatedAt = new Date().toISOString()
```

`evaluatedAt` 在模块求值时生成，所以只有在模块真的被重新 `import` 时才会变。日志里同时带
`import.meta.url`，用来区分是哪条路径生效的：

| 现象 | 含义 |
| --- | --- |
| 时间戳变、URL **不变** | Cordis HMR 真的替换了模块 |
| 时间戳变、URL 带 `?mics=` | HMR 没生效，内核的"产物监视自动 reload"回退在起作用 |
| 时间戳不变 | 两者都没触发（检查 `pnpm watch:plugins` 是否在跑） |

## 跑法

```bash
# 把示例目录也当成插件根（Windows 用分号分隔）
MICS_PLUGIN_ROOTS="plugins;examples" pnpm dev
```

启动日志里应出现：

```
demo.hmr-probe apply · evaluatedAt=2026-11-04T... · url=file:///.../examples/hmr-probe/dist/main.mjs
```

另开一个终端：

```bash
pnpm watch:plugins
```

然后改一行 `src/main.ts`（比如加个注释），保存。观察主进程日志：

- 出现第二条 `apply`，`evaluatedAt` 变了 → 热替换生效；
- 没有第二条 → HMR 与回退都没工作。

## TODO（等 addon 支持 Electron 45.0.0 stable 后）

当前 `node-addon-require-builtin@0.1.9` 的 V8 指纹白名单不含 Electron 45.0.0 stable，
所以 HMR 被前置检查跳过，只能验证"产物自动重载"（日志里 URL 带 `?mics=`）。

等它支持后，用同一个探针做真正的 HMR 验证：

1. 启动日志出现 `HMR 前置检查：… 内部加载器=true`，且没有 `HMR 跳过`；
2. 改 `src/main.ts`，期望 `apply` 再次打印、`evaluatedAt` 变化，而 `url` **不带** `?mics=`；
3. 若成立，评估是否保留内核的产物回退监视（HMR 存在时它已经自动让位）。

## 已知前提

- HMR 需要 `node-addon-require-builtin`（已在 `apps/desktop` 的 devDependencies），
  且 HMR 的 `watch.root` 必须覆盖 `examples/`（bootstrap 里已经加上）；
- HMR 不可用时，内核的开发期产物监视会接管；两者同时存在时只保留 HMR。

## 用它排查"HMR 到底有没有用"

当前实例信息也可以直接查（RPC）：

```
target: demo.hmr-probe
method: probe/info
→ { evaluatedAt, url, pid }
```

`url` 里有没有 `?mics=`，就是判断哪条重载路径生效的依据。
