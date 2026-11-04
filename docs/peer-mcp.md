# 会话协作 MCP

Codex 和 Claude 使用 `peer-client.mjs` 的 stdio MCP；DeepSeek 使用同一 Host 中的 `deepseek-plugin.mjs`。当前共用工具目录有 **21 个工具**，已启动的旧 MCP worker 可能仍保留旧目录。

## 路由和回复

先调用 `bridge_self` 确认本机当前会话。调用 `bridge_list_threads` 按完整标题、项目、状态查询；只有确认唯一目标后，才使用 `{toApp, toThreadId}` 发送。标题支持检索，但不是唯一标识，不能作为 `toThreadId`。

```json
{"toApp":"claude","toThreadId":"<查询确认的目标ID>","text":"请检查接口设计并回复结论","messageId":"review-api-v1","expectReply":true}
```

使用 `bridge_send` 发送；接收方使用 `bridge_ack` 确认消费，使用 `bridge_reply({messageId,text})` 回复。路由器自动返回来源会话并在空闲时唤醒。`delivered` 只表示投递，不代表已阅读；结果未知的派发不会自动重发。相同请求复用稳定的 messageId，不同内容不能复用。

`expectReply:false` 表示通知，接收方不得回复或继续转发。`bridge_receive` 查看收件箱，`bridge_message` 读消息状态，`bridge_archive_messages` 归档已结束消息，`bridge_health` 查看组件和原生连通性。

## 健康通知与超时诊断

`bridge_health({app:"all",subscribe:true})` 订阅每 30 秒独立探测、经过连续故障确认的通知；`subscribe:false` 退订。连续至少 3 次失败且持续至少 60 秒才发一次故障通知，确认恢复后再发一次恢复通知。单次失败记录为 degraded，不触发通知。未订阅及 `runtime/router/protected-threads.json` 中的受保护会话不会收到健康通知。

每端同时最多一个探测，定时与手动检查共用结果。HTTP 服务预算 10 秒、原生线程列表预算 75 秒；慢端不阻塞其他端落盘。`bridge_health` 等待约 2.5 秒后可返回 `checking:true` 与最近完成样本的 `checkedAt/ageMs`，没有样本时为 `ok:null`。`ok` 是最近完整探测结果，`confirmedOk` 是通知确认状态；错误步骤、预算、耗时及错误码见 `steps` 与 `runtime/router/health-probes.jsonl`。普通任务预算和未知写入不重放规则不变。详见 [健康监测](health-monitoring.md)（英文）。

## 决策

使用 `bridge_request_decision`，提供精确目标、question、2–10 个 options，以及可选 recommendation/context。请求被接受后结束本轮等待，不猜答案或轮询。接收方调用 `bridge_answer_decision`；答案会唤醒原会话继续。`bridge_decisions` 查看收到的决策。

决策答案只提供任务方向，不能批准工具权限。

## 创建任务和读取配置

先用 `bridge_projects`、`bridge_models` 确认目标项目和可用模型，再用 `bridge_create_task` 创建。创建新会话需要用户授权和非空初始 prompt。传入 model/effort 后，用 `bridge_settings` 读回实际设置，不能把请求值当成已生效值。使用 `bridge_task` 跟踪任务，使用 `bridge_read_thread` 读取原生会话。

Codex 支持登记项目及其现有本地 worktree 目录的严格匹配；不提供创建新 git worktree 或 cloud 环境的桥接操作。已有会话保持项目归属。

DeepSeek 的 workspaceId、workspaceName、workspacePath、originCwd 和 cwd 分别读回；cwd 不代替工作区身份。外部 HTTP `/v1/workspaces` 可列出、登记原生工作区。

## Codex 完全权限

创建任务时可显式设置：

```json
{"toApp":"codex","prompt":"<用户授权任务>","idempotencyKey":"job-v1","sandboxMode":"danger-full-access","approvalPolicy":"never"}
```

完全权限时不传 writableRoots。省略 sandboxMode 时沿用本机配置，初始默认 `workspace-write` / `on-request`。

已有空闲、托管且未受保护的 Codex 会话可使用：

```json
{"toApp":"codex","toThreadId":"<托管会话ID>","sandboxMode":"danger-full-access","approvalPolicy":"never"}
```

将以上参数交给 `bridge_set_permissions`。活动会话、有待批准请求、受保护或非托管会话会被拒绝。结果 `appliedTo:next-turn` 表示下一轮生效，后续 send/wake 会恢复持久策略。

`bridge_settings.settings.nextTurnPermissions` 给出原生下一轮设置；顶层权限字段按 permissionScope 区分最近已执行轮和下一轮。完全权限仍受当前 Windows 进程身份和系统限制，不等于管理员权限。

额外 writableRoots 必须落入本机 `settings.json` 的 allowedWritableRoots，经过 realpath/junction 校验。对端不能修改这份白名单。

## 外部客户端

`client.mjs` 还支持 HTTP 桥接工具和任务专用 callback 凭证。使用 `--args-file <JSON路径>` 避免 shell 转义；不要把 token 写进任务正文或日志。每轮凭证仅适用于其自身任务。服务端 HTTP API 的主要路由见 [架构说明](architecture.md)。

## Callback reports from MCP-created tasks

The backend binds a task's originating peer to the router-generated creation header
and its exact durable `mcp-create` idempotency key. Callback payloads cannot choose
or override that peer. Reports are forwarded through the ordinary durable peer
queue; findings and blockers request a reply, while progress notices do not.
Callback decisions include the exact callback decision ID in their peer context,
so the answer resumes the original waiting task.

`accepted:true, delivery:"recorded_locally"` acknowledges callback storage only.
Peer queueing, native delivery and recipient acknowledgement remain distinct.
Forwarding cursors survive restarts, and stable callback IDs deduplicate a report
if the router exits after queueing it. A first deployment skips old history;
operators may select exact pending event IDs for recovery rather than replaying
the backlog. Existing task origins can be recovered only when the original
creation header and idempotency record agree.

`bridge_outbox({limit:20,stage:"waiting_for_adapter"})` 查询当前会话的发件回执，按新到旧排列，可将 nextCursor 作为下次的 after。发送重要指令时提供稳定的 messageId。若发送返回 SEND_RECEIPT_UNCONFIRMED，用 lookupMessageId 在原会话调用 bridge_message 核实，再决定是否按原 ID 和原参数重试。bridge_self 的 worker.status 比较运行中的代码和已安装代码；旧 worker 的状态也可在控制台适配管理页查看。
