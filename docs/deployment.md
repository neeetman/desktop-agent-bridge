# 部署与验证

## 前提

Windows x64，Node.js 24+，Python 3.11+ 且同目录含 pythonw.exe，Frida 17.9.1。Codex 和 Claude 使用 README 所列已核验的 Windows 桌面包，先完成登录/初始化。至少保持 Codex 运行，并选择本机已有调度会话。使用固定安装目录，避免运行后直接移动。

```powershell
npm ci
python -m pip install -r requirements-claude.txt
.\install.ps1 -CheckOnly
.\install.ps1 -CallerThread "<本机会话ID>" -WritableRoots "C:\Work"
```

如果 PowerShell 执行策略阻止脚本，可按组织允许的方式使用进程级策略运行，不需要为此修改系统级设置。安装器用系统工具发现当前用户的 Appx 安装位置；不依赖源机器的 WindowsApps 路径。

预检读取应用文件并验证三份兼容清单；不会附着、启动进程或改配置。已有其他目录的桥接器占用任务/端口时直接拒绝安装。不要绕过检查在同一用户下并行运行两份安装。

实际安装依次初始化本机策略和保护列表、启动 Codex HTTP 桥接、合并 MCP、可选安装 DeepSeek 插件、注册并启动守护。安装中途失败保留状态和备份，不会自动删除已有配置或重发不确定任务。按错误和日志修复后再继续。

## 本机数据

| 位置 | 内容 |
|---|---|
| `runtime/connection.json` | 本机 Codex HTTP 地址、token、PID、callerThread |
| `runtime/router/` | 路由、消息、决策、保护列表 |
| `runtime/mcp-config-backups/` | 配置与 cc-switch 备份，可能含凭证 |
| `runtime/supervisor/` | 守护配置、任务计划定义、日志 |
| `%USERPROFILE%\.desktop-session-bridge/settings.json` | 额外写入白名单和默认权限 |
| `%USERPROFILE%\.desktop-session-bridge/threads.json` | 托管会话的持久执行策略 |

Codex MCP 配置位于 `$env:CODEX_HOME/config.toml`，未指定时使用用户目录 `.codex/config.toml`；Claude 使用用户目录 `.claude.json`。备份后只合并 desktop-bridge 条目。cc-switch 数据库不存在时无需安装它；已知字段兼容时登记，不识别其表结构时报告跳过。

新机器不要复制旧机器的 runtime 或线程策略。通过安装参数登记本机白名单/保护会话，逐端重新查项目和会话 ID。凭证由本机服务重新生成。

## DeepSeek Harness

先安装并初始化 Harness Desktop，然后给安装命令增加 `-WithDeepSeek`。插件安装器合并用户目录 `.dsh/profiles/desktop/cordis.patch.yml`，部署到本机 `runtime/deepseek-native/releases/<内容版本>`，保留其他模型与插件设置。首次安装后让 Harness Host 加载该 profile；已有活动会话时不要强制热重载。

## 验收

1. `npm run status`：各选用组件健康，原生附着没有 incompatible 状态。
2. 两端实际调用 `bridge_self`，返回各自当前会话身份。
3. 在专用测试会话中双向消息往返，确认回复回到来源 ID。
4. 测试一次决策请求、结束等待、答复后同会话继续。
5. 需要完全权限时只对专用空闲托管会话测试，读回下一轮和实际执行轮设置，结束后恢复。
6. 无活动任务时测试桌面重启/页面刷新恢复，再单独验证 Windows 注销登录或整机重启。

离线测试和健康端口不能替代上述验收。仓库中没有自动发送真实任务的 smoke 脚本，以免复用源机器的会话 ID 或意外重启应用。

## 升级与卸载

部署目录中的 git pull 不会自动刷新桌面中缓存的 helper、MCP worker 或 DeepSeek 插件。无活动任务时先暂停恢复，完成依赖更新、兼容验证及对应组件重启，再确认原生读回和真实往返。不要自动重发 unknown 操作。

卸载先运行 `uninstall-autostart.ps1` 停止/删除守护任务，再根据各 connection.json 核验 PID 的脚本归属后停止独立组件。原生 helper 的路径/token 会在桌面进程内缓存；完成活动工作后重启相关桌面应用，再从 MCP/profile 中移除本桥接器自己的条目。保留其他配置。备份确认不再需要后再清理本机状态。

目前没有全自动迁移/完整卸载器；同机换目录请按 [迁移说明](migration.md) 操作。
