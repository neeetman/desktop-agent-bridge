# P0/P1 更新维护（v0.8）

本版本实现统一兼容协调器、构建/进程身份、按能力门禁、兼容目录、不可变适配快照、空闲切换日志、回退和实际 MCP worker 目录摘要。结构定位/多版本真实 canary 属于 P2，签名远程分发属于 P3，均未实现。

## 查询和诊断

```powershell
desktop-agent-bridge doctor
desktop-agent-bridge doctor --app codex
desktop-agent-bridge compat list
desktop-agent-bridge compat plan --app claude --profile "<list 返回的 ID>"
```

源码目录也可用 `node bin/desktop-agent-bridge.mjs` 代替全局命令。doctor 默认为被动模式，核对实际进程、安装包和磁盘哈希，不附着、不创建安装身份、不改配置。`doctor --app codex --probe` 还会核对已经存在的原生 helper 身份/就绪状态，不会自动安装 helper。

HTTP 后端与路由器均提供需本机 token 的 `GET /v1/compatibility`。状态区分 runningBuild、installedBuild、profile、adapter、进程代次和 worker 目录，不把版本号、HTTP 健康或 MCP 配置已写当作原生可用。worker 中的 alive=false 是历史观测；实际 serverInfo、bridge_self 返回的 clientRevision/toolCatalogDigest 用于判断当前工具目录。

新包已安装、旧桌面进程仍活跃时保留旧进程；不因此刷新页面、结束任务或启动第二个实例。相同进程代次的文件被替换时要求维护重启。PID 复用通过创建时间区分。

## 安装与恢复身份

本机 `runtime/updates/installation.json` 记录 installationId 和固定根目录。helper 同时绑定凭证代次、进程代次、profile/adapter 摘要和 activationEpoch，拒绝旧安装目录或旧代次复用。不要把这份状态复制到其他目录/机器。

从 v0.7 迁移时，旧 helper 不具备这些身份，报告 IDENTITY_MISMATCH 是预期保护。按 [迁移步骤](migration.md) 在维护窗口释放旧桌面进程内实例后再安装；安装新源码不会替现有旧目录服务热升级。

## 导入和空闲切换

本地适配包目录必须包含 `profile.json` 与 `adapter/` 下 profile.adapterFiles 列出的自有源码。profile 需符合 compat/schema.json 的核心契约，桌面文件哈希与 embedded manifests 一致。目录穿越、越界 symlink、代码摘要不符和复用 ID 改写内容会被拒绝。本地导入表示操作者信任该代码；当前没有在线下载或签名信任系统。

```powershell
desktop-agent-bridge compat import "<本地适配包目录>"
desktop-agent-bridge compat plan --app codex --profile "<目标ID>"
desktop-agent-bridge compat activate --app codex --profile "<目标ID>" --when-idle
```

首次原生操作会为明确匹配的构建选择 profile 并快照适配源码。已选 profile 在同一进程内保持稳定；更新来源文件不会覆盖快照。新进程优先选当前目录中匹配的 profile。需要同进程换适配包时显式 activate。

切换会先持久化 waitingIdle，再做原生全局空闲/审批状态探测；有 in-flight lease 或 protected 会话则阻断。Codex 的全局空闲探测依赖 loaded-thread/read 契约，无法确认完整状态时保持阻断。Claude 使用原生 session manager 读运行状态。不替用户回答审批。

忙碌时命令返回 REFRESH_DEFERRED_BUSY，保留 waitingIdle。已安装的 supervisor 每约 30 秒重试已经明确请求的候选；未运行 supervisor 时可重试同一条 activate 命令。它不会自动选择其他候选。

```powershell
desktop-agent-bridge compat recover --app codex
desktop-agent-bridge compat rollback --app codex
```

recover 只能取消尚未开始附着的 waitingIdle。附着开始后失败或崩溃进入 recoveryRequired，阻断新的派发，不盲目重复替换；完成活动工作并重启桌面后，下一次选择根据新进程代次恢复。rollback 使用上一份不可变快照，仍需匹配当前桌面哈希和空闲条件，不能自动降级桌面应用。

切换日志与选用结果原子保存在 `runtime/updates/state.json`；日志保留最近 1000 个协调事件。只回退适配代码/选用，不回退消息、决策、回执或线程权限。

## MCP 刷新

```powershell
desktop-agent-bridge compat refresh-mcp --app codex
desktop-agent-bridge compat refresh-mcp --app claude --thread "<精确空闲会话ID>"
```

Codex 当前使用全局 reload：有任何配置的 protected 会话、活动/待审批线程或不能确认的原生状态时拒绝。Claude 只请求指定空闲会话的 mcpReconnect。原生刷新请求成功仍需该会话再调用 bridge_self 核验实际 clientRevision/toolCatalogDigest。

Claude 页面 reload/quit 不作为自动恢复手段。进程和 HTTP 失败仍由独立看门狗恢复；未知构建或协议不匹配不会通过反复刷新来修复。

## 队列和错误

已有排队消息遇到已确认“尚未派发”的更新阻断时保持 queued，并报告 blockedByUpdate；没有确定证据的派发保持 unknown。TTL 不因更新自动延长，已完成任务不重发。对端更新时收到的决策答案先持久排队，恢复后仍返回原 threadId。

若更新阻断恰好发生在任务已预留之后，任务可能保留 failed/not-started 的幂等记录，按记录核对后处理；不会自动删除原记录并重发。unknown 始终需要精确 native 输入/turn 对账。

`compat/catalog.json` 可通过 `revoked: ["codex:<profileId>"]` 或对应 profile.revoked 标记撤销，适用于已缓存历史 profile。缓存/失败结果随进程代次、配置和文件身份重新评估。额外权限白名单与每线程策略继续保留，不静默改变完全权限、模型、effort 或工作区。

## 验证范围

协调、门禁、切换/崩溃/回退和队列行为用离线集成测试验证；被动 doctor 对源机器两款桌面实际文件做哈希核对。本次没有从独立仓库向生产桌面安装新 helper，没有重启桌面或替换正在运行的旧服务。v0.8 的真实更新 canary、第二台机器和整机重启仍需维护窗口验收。
