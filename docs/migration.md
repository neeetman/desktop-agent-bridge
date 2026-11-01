# 从旧运行目录切换

## 使用独立仓库作为本机安装

可以直接使用固定路径的源码 checkout，按 README 执行 `npm ci`、安装 Python 依赖，然后运行 `scripts/install.ps1`；不必先全局安装 npm 包。该目录必须保持固定，包含本机忽略的 runtime。正在运行时不要移动目录、切换源码版本或用另一份全局 npm 安装争抢端口。

同步修复到 Git 不等于迁移完成。旧 v0.7 的桌面进程内 helper 没有 v0.8 的安装身份及 binding；复制 runtime、改 MCP 路径或重启路由器都不能替代完整切换。若选择“完成当前工作后再切换”，当前服务继续运行，不自动安排重启或修改登录任务。

## 空闲维护窗口

独立仓库建立后，旧目录仍可继续提供服务。创建仓库不会自行改写现有 MCP 路径、计划任务或关闭桌面端。以下步骤需要安排无活动任务的维护窗口。

1. 保存旧安装的源码版本、runtime、本机 `.desktop-session-bridge` 策略，以及两端配置备份。它们可能含凭证，只能本机保管。
2. 在旧目录执行 `uninstall-autostart.ps1`，停用独立看门狗和守护任务。
3. 核验各 connection.json 的 PID、命令行和旧目录脚本归属后停止旧后台组件；不要按进程名批量停止 Node/Python。
4. 完成活动工作后关闭相关桌面应用，释放原生管道和进程内缓存。仅换 MCP 配置路径不能保证 helper 不再引用旧目录。
5. 若需保留本机历史，离线复制 runtime 到新目录的本机 runtime，再逐项检查旧绝对路径。所有 PID、解释器路径、MCP/profile 引用和守护配置必须重建；不复制这些数据到其他机器。本机线程策略和原生会话 ID 保持在原用户下。
6. 从新目录安装依赖，打开已核验桌面端，用本机调度 ID 执行 `scripts/install.ps1`；重新传入保护会话列表，使用 DeepSeek 时加 `-WithDeepSeek`。DeepSeek 安装器替换已管理的插件条目。
7. 验证任务/MCP/profile 都指向新目录，完成原会话双向往返和决策测试，确认旧进程没有再次启动。

安装器检测到其他目录的计划任务或监听进程会拒绝覆盖。它没有自动迁移持久消息队列或进程内 helper 的功能。

回退时同样先停用新安装并释放桌面进程内缓存，再恢复旧配置、启动任务和目录；不要让两份安装竞争固定端口/管道。验收完成前保留旧目录及本机证据。

## 必须保留与重建的数据

- 保留消息、job、决策、回执、幂等 key、三端任务状态、token/callback 授权以及保护线程记录；不要重新派发 unknown 请求或把旧任务当新任务导入。
- 保留用户级 `.desktop-session-bridge` 设置和每线程策略，不能重置为默认权限。历史 callback 可能仍指向旧目录的客户端/凭证文件，未结束前保留这些文件。
- 不复用 `runtime/updates/installation.json`、进程 binding、lease、活跃过渡及 PID/connection 观测。新目录必须建立自己的安装身份；从已有 v0.8 目录迁移时尤其不能照搬这一层状态。
- 重建计划任务动作/工作目录、MCP 客户端绝对路径、DeepSeek Host 发布目录，以及各 connection 文件中的新进程观测。只复制持久队列不会完成这些工作。

新目录内的预检和安装入口：

```powershell
npm ci
python -m pip install -r requirements.txt
.\scripts\install.ps1 -CheckOnly
# 仅在旧安装停止、桌面进程内旧 helper 已释放后执行：
.\scripts\install.ps1 -CallerThread "<本机调度会话ID>" -ProtectedThreads @("<重要会话ID>") -WithDeepSeek
```

验收需确认计划任务、MCP 和 DeepSeek profile 均指向新 checkout，三端原生健康、实际 `bridge_self` 身份和新工具目录正确；用专用测试会话验证往返及决策，核对原持久记录仍在且无重复派发。整机重启后的验收单独进行，不能用离线测试或 HTTP `/health` 代替。
