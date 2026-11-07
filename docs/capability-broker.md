# 能力（capability）跨进程改造

> 现状：能力实现是**活对象**——方法 + 回调 + 事件。它只能活在创建它的进程里，
> 所以 `download-manager`、`shell` 这类**提供方**插件只能留在主进程。
> 本文给出让「消费者在子进程、提供者在宿主」成立的改造方案。

## 1. 为什么现在过不去

两个内置能力的形状（`packages/sdk/src/contract/capability.ts`）：

```ts
// FILE_TRANSFER
create(spec: FileTransferSpec): FileTransferHandle
interface FileTransferSpec {
  onProgress?: (progress: { loaded: number; total: number }) => void
  onRestart?: () => void
  // ...
}
interface FileTransferHandle { start(): Promise<Outcome>; stop(): Promise<void> }

// SHELL_EXECUTE
spawn(spec: ShellExecSpec): Promise<ShellProcess>
interface ShellProcess {
  readonly pid: number | undefined
  kill(signal?: string): void
  detach(): void
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): Disposable
}
```

三处跨不过去：

1. **回调**：`onProgress` / `onRestart` 是函数，结构化克隆会直接抛错；
2. **返回句柄**：`FileTransferHandle` / `ShellProcess` 是带方法的对象；
3. **事件**：`once('exit')` 是同步订阅。

## 2. 结论：提供方留在宿主，消费者拿代理

能力名是契约，实现留在宿主进程。子进程里的 `ctx.capabilities.require(name)`
返回一个**代理**：方法变成 RPC，回调变成订阅，事件变成宿主推送。

这不需要改动能力定义本身——只需要：

- 宿主侧记录每个 provider 导出了哪些方法；
- 子进程侧 `require()` 拿到代理对象（方法返回 Promise，与现在一致）；
- 子进程**不能** `provide()`（提供方必须是可信进程），调用直接报错。

## 3. 协议

在 `@mics/plugin-host` 的协议里加三类消息（与已有的 `invoke` / `event` 同构）：

| 消息 | 方向 | 载荷 | 用途 |
| --- | --- | --- | --- |
| `cap:call` | 子进程 → 宿主 | `{ capId, method, args }` | 调 provider 的方法 |
| `cap:result` | 宿主 → 子进程 | `{ id, ok, value \| error }` | 返回值 / 错误 |
| `cap:event` | 宿主 → 子进程 | `{ subscriptionId, event, payload }` | 回调与事件 |

`args` 里不允许出现函数：遇到函数参数（如 `onProgress`），代理把它换成
`{ __subscription: id }` 占位，宿主侧再替换成真实回调。

## 4. 两个能力的适配

### 4.1 `SHELL_EXECUTE`（简单）

- `spawn(spec)` → `cap:call('spawn', spec)`，返回 `{ handleId, pid }`；
- `kill` / `detach` → `cap:call`；
- `once('exit', cb)` → 订阅 `handleId` 的 `exit` 事件，宿主在子进程退出时推送。

现有调用点（`plugins/launch`）一行不用改：它拿到的是同形状的对象。

### 4.2 `FILE_TRANSFER`（要改契约）

`spec` 里带回调，代理必须先注册订阅再调用：

```ts
// 子进程里的代理实现（示意）
create(spec) {
  const progressId = subscribe(spec.onProgress)
  const restartId = subscribe(spec.onRestart)
  const { handleId } = await call('create', stripCallbacks(spec))
  return {
    start: () => call('start', { handleId }),
    stop: () => call('stop', { handleId })
  }
}
```

宿主按 100ms 节流推送 `onProgress`——下载进度本来就不需要每条字节都过界。

## 5. 迁移步骤

| 步骤 | 内容 | 风险 |
| --- | --- | --- |
| 1 | `@mics/plugin-host` 加 `cap:` 三类消息与订阅表 | 低 |
| 2 | 子进程 `capabilities` 服务：`require` 返回代理，`provide` 报错 | 低 |
| 3 | 宿主 `PluginWorkerHost`：按 provider 的方法表路由 | 中（要拿得到 provider 实例） |
| 4 | 先把 `SHELL_EXECUTE` 跑通（无回调），再改 `FILE_TRANSFER` | 中 |
| 5 | 把 `launch` 迁到 `sandboxed`（它只消费能力） | 中 |
| 6 | 验收：子进程插件调用 `FILE_TRANSFER` 下一个小文件并收到进度 | 高（要端到端） |

第 3 步需要一个前提：宿主能按能力名拿到 **provider 实例**。
`CapabilitiesService` 已经有这个能力（`get(name)`），但它是 cordis 服务，
子进程的请求要在内核上下文里调用——和 `ipc.handleFor` 同一类做法。

## 6. 风险

- **回调改事件是契约变更**：消费者（`download-vanilla`、`download-mod` 等）
  目前都直接传 `onProgress`。代理层如果做得好，它们一行不用改；
  做不好就要逐个改调用点。
- **错误语义**：跨进程后 `Error` 会丢栈与 `code`。协议里只传 `message`，
  需要 `code` 的能力要显式加字段。
- **进度事件节流**：不节流会把 IPC 打满；节流太狠会让进度条卡顿。
  100ms 是经验值（下载页本来就是每帧刷）。
- **`provide` 在子进程不可用**：将来如果有第三方插件想提供能力，
  要么留在 `full`，要么等能力契约彻底消息化（另一件事）。

## 7. 不做的事

- 不把 `FILE_TRANSFER` 改成「纯 RPC」——它的语义就是长任务 + 进度，
  事件模型比轮询合适。
- 不允许子进程提供能力：能力是宿主对插件的授权，反过来会让沙箱失去意义。
