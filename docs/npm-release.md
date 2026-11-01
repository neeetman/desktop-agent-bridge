# npm 发布

包名：`@neeetman/desktop-agent-bridge`，版本 0.8.0，MIT。无 scope 的同名包属于已有 npm 登记，不能作为本项目的新包名。scope 的实际发布权限由 npm 账户决定，与 GitHub 登录分别管理。

0.8.0 已于 2026-11-01 公开发布并完成 registry 摘要和隔离安装核验，见 [发布记录](releases/v0.8.0.md)。当前仓库的 0.8.1 目录整理仍为待发布版本。

发布使用维护者的 npm 身份。源码配置允许公开发布，提供 desktop-agent-bridge CLI，并用显式 files 清单排除 runtime、凭证、日志、测试、安装包摘录和 node_modules。安装本 npm 包不会自动修改 MCP/启动桌面应用；install 是明确的独立命令。

维护者在终端完成认证，确认拥有 @neeetman scope 权限，再执行：

```powershell
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm test
npm run test:python
npm run check
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org/
```

根据 npm 官方规则，公开 scope 包使用 `--access public`；正式发布需要满足账户的认证要求。见 [npm 官方发布说明](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)。不要把 token 或验证码写入仓库/聊天/运行日志。

发布后可在目标机器安装：

```powershell
npm install -g @neeetman/desktop-agent-bridge
python -m pip install frida==17.9.1
desktop-agent-bridge doctor
desktop-agent-bridge install -CallerThread "<本机已有Codex会话ID>" -WritableRoots "C:\Work"
```

仍需 Windows、Node.js 24+、Python 3.11+（含 pythonw.exe）及已核验桌面端。CLI 使用实际安装包目录保存本机 runtime，因此不要在服务工作时直接卸载或覆盖全局包。升级前先完成活动任务，按 [迁移/维护说明](update-operations.md) 处理缓存 helper、服务及 worker。

CI 只执行离线测试，不配置自动 npm 发布，也不保存发布凭证。正式发布后核对 npm 版本和 tarball 摘要，不能把 npm pack 或 dry-run 当成已发布。
