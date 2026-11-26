# A2A / AG-UI 协议实现

> 复验发现的四项 A2A 缺陷已修复。详见 [复验报告与修复记录](runtime_protocols_revalidation.md)。

提供两个可选协议包，基础 SDK 不加载协议依赖。完整业务协议入口分别是 `createA2aService()` 和 `createAguiAgent()`；原有 `createA2aAdapter()` / `createAguiAdapter()` 保持文本模式兼容，不能用文本适配器验收完整能力。两个协议包纳入与主包相同的 npm 发布流程（顺序与版本约定见 [CONTRIBUTING](../../../CONTRIBUTING.md)），云端透传未验收。

## 已实现能力

| 方面 | A2A 1.0 | AG-UI 1.0 |
| --- | --- | --- |
| 传输 | 官方 JSON-RPC、HTTP+JSON REST、gRPC，共享任务引擎 | HTTP/SSE，官方 schema、分块转换、时序验证与客户端 reducer |
| 基础 | 发现、发送、流式发送、查询、过滤分页、取消、活跃任务订阅 | 生命周期、文本、错误、取消；完成 run 的快照重放 |
| 续接 | 同一 taskId 的 INPUT_REQUIRED / AUTH_REQUIRED 多轮消息，context、历史和 checkpoint | 新 runId + 相同 threadId 的 interrupt/resume，校验答案覆盖、重复与过期 |
| 内容 | text/raw/url/data parts，文件 artifacts、append/lastChunk，MIME 协商 | 文本和多模态输入、工具调用/参数/结果、共享状态快照与 JSON Patch |
| 扩展事件 | 扩展 URI 协商、required 校验和激活；业务解释扩展语义 | reasoning、activity、step、subagent、CUSTOM、RAW；包括官方 chunk 转换 |
| Card / 推送 | 认证扩展 Card、签名/验签工具；Webhook 配置 CRUD/分页与投递 | 由应用回调产生业务结果与中断 |
| 持久化 | 身份隔离的任务、幂等索引、checkpoint、推送配置 | 身份隔离的线程、近期 run 快照、状态、checkpoint、待处理 interrupts |

基于 `@a2a-js/sdk@1.3.0` 和 `@ag-ui/core/client/encoder@1.0.5`。这是具体版本的实现及本地互操作验收，不代表通过官方完整 TCK 或支持后续所有协议版本。A2A 不提供 0.3 兼容绑定。

## 完整 API 的使用

可运行示例：[protocol_agent/full.ts](../../../examples/protocol_agent/full.ts)，命令见该目录 README。它在 8000 提供 AG-UI，在 8001 提供 A2A JSON-RPC / REST，并将两者接入同一个 runtime 和本地存储。无需真实模型或云凭据。

```ts
import { AgentArtsRuntimeApp, FileProtocolStorage } from '@huaweicloud/agentarts-sdk/sdk/runtime';
import { createAguiAgent, EventType } from '@huaweicloud/agentarts-protocol-agui';

const runtime = new AgentArtsRuntimeApp({ maxConcurrency: 4 });
const storage = new FileProtocolStorage('./.agentarts-protocol');
runtime.use(createAguiAgent({
  authenticate, storage,
  execute(input, context) {
    context.emit({ type: EventType.STATE_SNAPSHOT, snapshot: { stage: 'ready' } });
    if (!context.checkpoint)
      return context.interrupt([{ id: 'approval', reason: 'confirmation' }], { stage: 'approval' });
    context.emitText('Resumed');
    return { result: { done: true } };
  },
}));
runtime.run('127.0.0.1', 8000);
```

`authenticate` 必须验证凭据并返回服务端解析的 `{ tenantId, subject }`。身份不能来自请求体、taskId/threadId 或客户端声明的路由 tenant。A2A Card 的路由 tenant 与身份 tenant 独立校验。

`createA2aService({ runtime, authenticate, agentCard, storage, execute })` 返回 `http`（可传给 Node createServer 或挂载于 Express）、`grpcDefinition`、`grpcService`、`handler` 和 `close()`。HTTP 默认路径是 `/a2a`、`/a2a/rest`、`/.well-known/agent-card.json`。Card 必须显式声明真实 URL、绑定、版本及认证方式；HTTPS 为默认要求，仅回环开发允许 HTTP。A2A 请求使用 `A2A-Version: 1.0`。

```ts
import * as grpc from '@grpc/grpc-js';
// service 是 createA2aService() 的返回值；Card 同时声明实际 GRPC 地址。
const server = new grpc.Server();
server.addService(service.grpcDefinition, service.grpcService);
// 生产环境配置 TLS；不要使用 createInsecure() 暴露公网端口。
server.bindAsync('127.0.0.1:8002', credentials, onBound);
```

gRPC 服务器、TLS 与监听端口由宿主应用管理；SDK 注册认证后的官方绑定。HTTP/REST/gRPC、AG-UI 和既有 HTTP/WS 共享同一 runtime 的执行名额。`runtime.shutdown()` 同时关闭所有已注册协议引擎；应用还须关闭自己创建的监听器。

## 执行与业务边界

A2A 执行器接收官方 typed `Message`，可返回字符串或 `{ state, artifacts, checkpoint }`。`context.emitArtifact(artifact, append)` 持久化并发布产物；`setStatus()` 设置最终/等待状态，在执行真正结束后发布。`saveCheckpoint()` 显式保存恢复点。遇到 INPUT_REQUIRED / AUTH_REQUIRED，后续用户消息携带同一个 taskId 进入同一任务；终态不允许继续。若上一轮仍在投递最后一批 Webhook，续接暂时返回操作错误，投递批次结束后可重试。取消已暂停的任务也会推送状态更新。

AG-UI 执行器接收未经文本扁平化的完整校验输入，`context.emit()` 接收官方 Event，`emitText()` 提供文本便捷接口；生命周期由适配器管理，不能由业务重复发送。`callTool()` 只能引用本次输入声明的工具，发布调用供前端执行；前端在后续输入中回传 tool 消息。`toolResult()` 可发布服务端受控工具的结果。SDK 不自动执行客户端提供的函数、代码或工具参数。

`context.interrupt(interrupts, checkpoint)` 结束当前 run 为 interrupt；客户端使用新 runId、相同 threadId，并传入 `resume: [{ interruptId, status: 'resolved', payload }]` 或 cancelled。待处理中断必须全部回答；已过期项不能 resolved。`context.resume`、`checkpoint` 与 `state` 提供恢复输入。状态仍需按业务权限校验；协议校验不等于业务授权。

完整模式保留 system/developer/tool 等合法消息角色。对外应用必须自行决定这些输入的信任等级，不能把客户端内容当作服务端可信策略。扩展、工具、附件消费与业务副作用由回调实现；协议层提供类型、传输与状态契约，不会自动赋予应用某个外部服务的能力。

文件 url 和 AG-UI provider/file 来源保持为引用，不自动下载、不读本地路径。需要消费文件时，应在业务侧增加大小、类型、来源与权限控制。structured data 支持 null；二进制 raw 使用官方 protobuf/ProtoJSON 编码。

## 可替换存储及恢复

`ProtocolStorage` 的 `get(scope,key)`、`update(scope,key,change)`、`list(scope)` 可替换。update 必须对同一键原子执行，change 为纯函数；scope 由 namespace 与认证身份构成。不同逻辑 Agent 共用存储时应配置不同 namespace，并在重启间保持该值稳定。

内置 `MemoryProtocolStorage` 与 `FileProtocolStorage`。拒绝符号链接目录与记录、危险 JSON 键及非 JSON 对象。写入时同步文件并原子替换。POSIX 上目录默认 0700、记录 0600，替换后同步目录。Windows 上应将存储放在仅运行账户可访问且可修改的目录，权限由 ACL 管理，SDK 不校验 ACL，也不执行目录 fsync。支持可选 32 字节 AES-256-GCM 密钥。配置密钥时拒绝读未加密记录；密钥应由环境/密钥管理服务提供，不能提交到代码仓。

默认最多 1024 条记录、单条 4 MiB、总量 64 MiB；A2A 幂等索引也计入记录数，每身份默认最多 64 个任务。满容量时拒绝写入，不能无限使用磁盘；应用需制定保留/归档策略。AG-UI 保留最近至多 8 个 run 并按记录大小淘汰旧 run，旧 run 淘汰后不保证永久幂等；A2A 历史也有大小上限。

已结束/等待的任务与线程可在重启后查询和续接；进程在执行中崩溃后，A2A 将遗留 owner 的任务转为 INPUT_REQUIRED，等待显式后续消息从 checkpoint 继续；AG-UI 使用新 runId 恢复业务 checkpoint。同一个旧 running runId 返回冲突。不会自动重放未知副作用；业务必须设计幂等键与恢复点，不能承诺外部副作用 exactly-once。

FileProtocolStorage 的协调范围是**一个 OS 进程、一个目录**，可在该进程中创建多个 storage 实例。它不支持多个进程同时写同一目录。多副本仍需另行实现数据库原子性、分布式所有权/租约、事件通道与集群容量控制，不能只换存储就宣称多实例可用。

## 安全与资源约束

认证默认 5 秒、每认证器最多 64 个实际未结束调用；异常完全脱敏。HTTP 默认 1 MiB / 10 秒及 64 个活跃协议请求。CORS 仅支持配置的精确来源；OPTIONS 不执行 Agent。旧 `/invocations`、`/ws` 若启用，应另行保护。

完整执行默认 120 秒协作取消，只有实际执行/清理完成才释放名额。A2A 断流不取消任务，应显式 CancelTask；AG-UI 断流请求取消。慢消费者丢失历史会得到显式错误。AG-UI 累计输出默认 1 MiB，事件窗口 256 条 / 512 KiB，单条事件也受窗口字节上限约束；A2A 单条产物 512 KiB、产物总计 1 MiB、事件窗口及累计输出各 2 MiB。协议事件通过官方 schema 与时序校验，状态 JSON Patch 禁止原型修改。

成功结果先持久化再发布终态；持久化失败返回协议错误，不伪报成功。回调必须响应 signal 并结束资源清理，SDK 不能强制终止任意用户 JavaScript 或回滚外部事务。

Webhook 必须显式配置 allowedOrigins；默认 HTTPS，仅显式本机测试允许回环 HTTP。拒绝私网/元数据地址、URL 内凭据、重定向；每次 DNS 解析后锁定 IP，限制 DNS 与 HTTP 超时、并发、请求/响应大小。配置持久化。投递使用有界并发，任务在当前批次等待可用名额及投递结果，因此慢回调会增加同步等待时间。失败脱敏记录，当前没有跨重启持久化 outbox 或 exactly-once 保证。接收方须幂等处理，并通过任务查询补偿。Basic/Bearer 凭据只用于对应 allowlist 目的地。

Card 签名通过 `signCard` 在最终能力声明后生成；导出官方 `generateAgentCardSignature` / `verifyAgentCardSignature`。密钥选择和可信公钥解析属于部署配置，不自动访问任意 jku 地址。扩展 Card 默认要求认证，公共 Card 也默认认证，公开发现需显式 publicAgentCard。

## 验证与发布

运行 `pnpm typecheck`、`pnpm test`、`pnpm test:protocol`、`pnpm test:integration`、`pnpm build`。详见 [验收记录](runtime_protocols_validation.md)。默认测试包含协议验收及既有 SDK/CLI 测试。

四个包按 identity → SDK → A2A → AG-UI 协调发布，实际发布前应用 changeset 并通过版本校验。当前没有执行发布。

未提供云端测试地址，本轮不包含 AgentArts 网关路径、SSE 透传、实际凭据/模型与 TLS 部署验收；也不包含多实例/分布式验收。

规范参考：[A2A 1.0](https://a2a-protocol.org/latest/specification/)、[AG-UI](https://docs.ag-ui.com/spec/1.0)。
