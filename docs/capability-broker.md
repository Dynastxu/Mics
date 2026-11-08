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

---

## 8. 实现状态（分支 `feat/plugin-permissions`，提交 `db52bfe`）

| 步骤 | 状态 |
| --- | --- |
| 1. 协议加 `cap-call` / `cap-result` / `cap-event` | ✅ |
| 2. 子进程 `capabilities` 服务：`require` 返回代理、`provide` 报错 | ✅ |
| 3. 宿主按 provider 方法表路由、句柄记账、回调还原 | ✅ |
| 4. `SHELL_EXECUTE` 跑通（句柄 `pid` + `once('exit')`） | ✅ |
| 5. `FILE_TRANSFER` 跑通（同步 `create` + `onProgress` 回调） | ✅ |
| 6. `launch` 迁到 `sandboxed` | ❌ 见下 |

### 一个实现上的坑：同步方法返回句柄

`FILE_TRANSFER.create()` 是**同步**的（返回句柄，不是 Promise），而跨进程拿不到
同一次往返的结果。代理的做法是返回一个**延迟句柄**：方法调用时先 `await`
内部那次 `create` 的响应，再按 id 路由。字段（如 `pid`）只在异步方法上提供，
因为同步读取字段没法等待。

### `launch` 为什么还迁不了

不是能力的问题，是**文件扫描**的问题：

`packages/java` 为了找本机 JVM，会 `readdir` 这些目录：

```
C:\Program Files\Java\*、C:\Program Files\Eclipse Adoptium\*、
%LOCALAPPDATA%\Programs\Eclipse Adoptium、JAVA_HOME、PATH
```

静态白名单表达不了「本机所有可能的 JDK 位置」。而且 `existsSync` 会把
`ERR_ACCESS_DENIED` 吞成 `false`，结果是**静默地找不到 Java**，比报错更糟。

三条出路，选一条：

1. **宿主代做探测**：`ctx.host.java.detect()` 在宿主进程里扫，插件拿结果。
   最干净，也符合「宿主能力」的方向；
2. **放宽读权限**到 `C:\Program Files`、`%LOCALAPPDATA%`，代价是沙箱边界变模糊；
3. **强制用户配置 Java 路径**，去掉自动探测。UX 有损。

推荐第 1 条：探测是只读的、结果可缓存，放在宿主侧正好。

### 剩下的插件

| 插件 | 卡点 | 出路 |
| --- | --- | --- |
| launch | JDK 探测（见上） | 宿主代做探测 |
| account | `safeStorage` 加解密 | 宿主代理（密钥不出宿主） |
| close-behavior | `Tray` / `Menu` | 托盘由宿主建，插件只发指令 |
| plugin-inspector | `dialog` / `BrowserWindow` | 宿主代开对话框 |
| logger | 要观察主进程 `ctx.logger` | **不应迁移**：观察者天然属于宿主侧 |
| download-manager / shell | 提供能力 | 已支持：提供方留在宿主 |
| kernel | 内核本身 | 保持 `full` |
