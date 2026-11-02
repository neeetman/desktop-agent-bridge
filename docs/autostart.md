# Windows 登录启动与恢复

执行 `install.ps1` 后，为当前用户注册两个任务：`DesktopSessionBridge-<用户SID末段>` 和对应的 `-Watchdog`。它们使用 InteractiveToken、最低权限，不保存 Windows 密码。

登录后启动桌面应用和守护，支持组件退出恢复、退避和独立的分钟级看门狗。它依赖交互式桌面，因此不是登录前的 SYSTEM 服务。正常退出的桌面应用在本次登录内保持关闭；异常退出可恢复。DeepSeek 仅在安装时选用 `-WithDeepSeek` 后由本安装器纳入管理。

恢复层次：Windows 任务 → `supervisor-task.pyw` → `bridge-supervisor.mjs` → HTTP 适配器、路由器、原生附着监控。桌面重启后重新发现 Codex pipe；Claude 页面刷新后自动重新附着，无需手动打开 DevTools。

```powershell
npm run status
node .\src\supervisor\supervisor-status.mjs pause
node .\src\supervisor\supervisor-status.mjs resume
```

pause 暂停当前守护恢复循环，通信服务仍在；下次登录恢复正常守护。停止服务前先停用看门狗，避免被立即重新启动。

进程枚举使用终止式错误处理，并要求结果包含可识别的守护进程自身。空列表、不完整快照或 WMI/CIM 查询失败不能解释为应用已退出；此时 `processInventory.ok=false`、错误码为 `PROCESS_SNAPSHOT_UNAVAILABLE`，跳过桌面启动、服务恢复和原生探测。已有进程继续运行，查询恢复后再正常管理。否则，把枚举错误当空列表会每约 15 秒重复启动 GUI，并在已有服务端口上触发 EADDRINUSE。`/health` 仍可反映守护 HTTP 存活，完整管理状态以 `/status` 的 processInventory 为准。

```powershell
.\scripts\uninstall-autostart.ps1
```

卸载脚本移除登录任务和看门狗，保留状态与配置。独立工作组件可能仍在运行，不代表已完整卸载；见 [部署说明](deployment.md)。

`runtime/supervisor/` 包含解释器/应用路径、运行状态、任务定义和日志。监控进程有心跳不等于原生连接可用；incompatible、waiting_for_native 等状态需分别诊断。未知桌面构建不会自动放宽哈希检查。

原生 MCP 兼容清单默认 `reloadOnAttach:false`。受保护会话存在时不进行全局 MCP reload，避免打断工作。安装或升级后仍应从各端真实调用工具确认目录已加载。

原运行目录曾验证组件异常恢复和真实通信；独立仓库迁移及另一台电脑的整机重启仍需各自验收。
