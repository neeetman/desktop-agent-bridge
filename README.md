# Desktop Agent Bridge

Windows 桌面端 Codex、Claude Code 与 DeepSeek Harness 的本机会话桥接器，当前版本 **0.8.0**，MIT 许可证。npm 包名为 [`@neeetman/desktop-agent-bridge`](https://www.npmjs.com/package/@neeetman/desktop-agent-bridge)。

会话可以通过 MCP 主动互发消息、接收回复、请求决策，并在答复到达时唤醒原会话。支持按标题搜索后用精确 ID 路由、多会话队列、项目/工作区、模型与 effort 读回，以及 Codex 托管会话的下一轮权限设置。

这是依赖桌面私有协议的独立项目。它复用正在运行的桌面会话，不启动替代的 Codex app-server。桌面更新后需要重新验证兼容性。

## 安装到另一台 Windows 机器

1. 将本仓库 clone 或解压到固定目录。安装 Node.js 24+、Python 3.11+（包含 `pythonw.exe`），并安装、登录 Codex 和 Claude 桌面端。打开 Codex，在该机器上选择一个已有会话作为调度会话。
2. 在仓库目录安装依赖：

   ```powershell
   npm ci
   python -m pip install -r requirements-claude.txt
   ```

3. 先运行只读预检。它验证依赖、桌面文件哈希、任务归属和端口冲突，不进行原生附着或安装：

   ```powershell
   .\install.ps1 -CheckOnly
   ```

4. 安装 MCP 配置、当前用户登录启动和故障恢复。使用新机器自己的会话 ID 和实际存在的目录：

   ```powershell
   .\install.ps1 -CallerThread "<本机已有Codex调度会话ID>" -WritableRoots "C:\Work"
   ```

   `-WritableRoots` 是额外写入目录的本机白名单；可省略，此时初始白名单为空，原生项目工作区权限仍有效。已有本机策略不会被安装器重置。可用 `-ProtectedThreads @("<重要会话ID>")` 防止对这些会话修改权限或全局重载 MCP。

   可选 DeepSeek Harness：先初始化它的桌面 profile，再在安装命令上添加 `-WithDeepSeek`。默认只管理 Codex 和 Claude。

5. 等待守护启动，运行 `npm run status`。在两端调用 `bridge_self`，再验证精确会话路由、回复和决策闭环。已有 GUI 会话可能需要重连 MCP worker；安装成功不等于旧会话已加载新工具目录。

安装器会备份并合并一个名为 `desktop-bridge` 的 MCP 条目，保留其他设置；缺少配置文件时会创建。检测到 cc-switch 时尝试同步其登记。登录启动使用当前用户，无需保存 Windows 密码。详细步骤见 [部署说明](docs/deployment.md)。

## 已验证的兼容范围

| 桌面端 | 版本 | 兼容约束 |
|---|---|---|
| Codex Windows x64 | `26.1027.3384.0` | 两份兼容清单校验 EXE、chrome.dll、app.asar |
| Claude Windows x64 | `4.29.0` | 兼容清单校验 EXE、app.asar |
| DeepSeek Harness | `0.2.1-rc.3` | 原生 Cordis Host 插件；升级后重新验证契约 |

Frida 固定为 `17.9.1`。未知 Codex/Claude 文件哈希会拒绝附着；不要通过直接更新哈希来声称兼容。当前只支持本机 Windows 桌面环境，HTTP 服务只监听 `127.0.0.1`。

## 使用与维护

- [MCP 消息、回复、决策与完全权限](PEER-MCP.md)
- [自启动与恢复](AUTOSTART.md)
- [部署、验证与卸载](docs/deployment.md)
- [从旧实验目录迁移](docs/migration.md)
- [架构与源码入口](docs/architecture.md)
- [Claude / Codex 更新适配设计](docs/update-resilience.md)
- [P0/P1 已实现的更新维护命令与边界](docs/update-operations.md)
- [npm 发布与安装](docs/npm-release.md)
- [本次验证范围](docs/validation.md)

运行数据、凭证、配置备份和日志位于 `runtime/`；权限白名单及托管线程策略位于 `%USERPROFILE%\.desktop-session-bridge\`。这些数据不进 Git。跨机器部署时重新生成，不复制旧机器的 token、会话 ID 或线程策略。

## 开发与验证

```powershell
npm ci
npm test
npm run test:python
npm run check
```

这些检查不会启动桌面应用或派发真实任务。Node 测试使用模拟原生连接及临时目录；Python 测试覆盖部署初始化、配置保留和清理边界。真实 GUI 验证需要在专用测试会话中单独执行，不在 CI 中自动发送消息。

本仓库从已验证的 v0.7 运行代码整理而来，排除了安装包提取物、旧的一次性分析脚本、真实聊天记录和本机运行状态。源机器的真实通信证据不随源码分发；独立仓库的离线测试不能替代第二台机器的冷安装和整机重启验收。

许可证见 [MIT](LICENSE)。发布包采用显式文件清单，不包含本机 runtime 或凭证。
