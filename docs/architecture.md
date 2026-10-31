# 架构与源码

```text
Codex / Claude stdio MCP        DeepSeek Host 原生插件
             \                  /
               peer-router.mjs
                 /     |     \
         Codex HTTP  Claude HTTP  DeepSeek HTTP
               |       |              |
       桌面原生管道  主进程/页面 API  Host 会话/工作区 API
```

| 源码 | 职责 |
|---|---|
| `bridge.mjs`、`signals.mjs`、`contracts.mjs` | HTTP 任务、持久状态、回传/决策、请求契约 |
| `native.mjs`、`codex-runtime.cjs` | Codex 原生管道、实时 Webpack/CJS 连接定位 |
| `codex-main-execution.cjs`、`execution-policy.cjs` | 托管会话创建/恢复、权限验证与持久化 |
| `codex-mcp-autoattach.py`、`codex-main-mcp.cjs` | 版本绑定 MCP 附着、状态和受保护的重载 |
| `claude-autoattach.py`、`claude-main-attach.cjs` | Claude 生命周期、重启/页面刷新附着 |
| `claude-file-relay.mjs`、`claude-native.mjs` | Claude 窄原生 API、transcript 和会话映射 |
| `deepseek-plugin.mjs`、`deepseek-native.mjs` | Host 工具、会话和工作区映射 |
| `peer-router.mjs`、`peer-catalog.mjs`、`peer-call.mjs` | 消息/决策路由、工具目录和三端语义 |
| `bridge-supervisor.mjs`、`supervisor-task.pyw` | 当前用户登录启动、恢复与看门狗 |
| `install.ps1`、`deployment.py` | 新机器预检和初始化 |

HTTP 端口：Codex 43127、Claude relay 43128、Claude 43129、router 43130、supervisor 43131、DeepSeek Host 43132、DeepSeek 43133。固定端口和原生管道目前限制同一交互用户使用一份安装。

HTTP 使用本机 Bearer token，拒绝带 Origin 的浏览器请求。凭证只从本机 connection 文件读取。主要后端路由：

| 路由 | 用途 |
|---|---|
| `GET /health`、`GET /v1/capabilities` | 进程与功能状态 |
| `GET /v1/projects`、`GET /v1/models`、`GET /v1/threads` | 项目、模型、会话查询 |
| `POST /v1/tasks`、`GET /v1/tasks/{id}` | 创建/跟踪任务 |
| `GET /v1/threads/{id}`、`POST /v1/threads/{id}/messages` | 读会话、发送 |
| `POST /v1/threads/{id}/wake` | 唤醒空闲会话 |
| `GET /v1/threads/{id}/settings` | 读回实际配置 |
| `POST /v1/threads/{id}/permissions` | Codex 托管会话下一轮权限 |
| `GET /v1/events`、`GET /v1/events/stream` | 事件和 SSE |
| `POST /v1/inbox`、`POST /v1/decisions/{id}/respond` | 主动回传及外部决策恢复 |

SSE 游标、消息去重、任务与决策持久化在本机 runtime。断线时结果不确定的操作保留 unknown，不自动重放。受保护会话和待批准请求不会被桥接器替代审批。

Codex helperRevision 绑定桥接源码字节，桌面文件哈希绑定应用构建，两者用途不同。修改 helper 源码后需重新计算其内容 revision 并运行 `npm run check`；修改桌面兼容清单必须附新的原生契约验证。
