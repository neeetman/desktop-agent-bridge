# Validating an unfamiliar desktop build

Open **适配管理 → 未知版本 · 生成与验收** in the console and select the package to import. Both Windows desktops must be running with desktop-bridge MCP installed. The validator creates its own test chats in run-specific workspaces and records their IDs in the report.

New Codex validation chats explicitly use `gpt-6-luna` with `low` reasoning effort. Native model readback must match before the fixture is accepted; validation does not fall back to the desktop's default model. The report records this selection with the fixture.

Import validates and stores a package. **已匹配** means the package matches the running build; use **空闲时激活** to attach and verify readiness. Import alone does not attach a helper. While maintenance or automatic validation is running, the console displays the operation and its start time and disables conflicting actions.

**开始验收** runs discovery and a live test. **检测到未知构建时自动验收** checks once per minute while the console is running and creates fresh test chats for each new build pair. The automatic check stages packages for review. Import a verified folder through **导入本机包**. Enable the console's Windows login preference to start monitoring after sign-in. Automatic validation is off by default.

The equivalent CLI commands are:

```powershell
desktop-agent-bridge compat discover --app codex
desktop-agent-bridge compat certify --app claude
desktop-agent-bridge compat import <verified-package-directory>
```

For diagnostic runs, the CLI also accepts both `--codex-thread` and `--claude-thread`. Supply two dedicated, idle, unprotected chats with MCP available. Keep the Codex chat in recent or pinned chats and use one without a bridge-managed execution policy.

- Discovery parses the installed ASAR without executing extracted bundles. It requires one structural match per required role, copies a digest-checked existing adapter and writes a quarantined `candidate.json`. An unsupported bundle layout, ambiguous matches, an unregistered version layout or a revoked fingerprint needs review.
- Validation binds to the running PIDs, their creation times and executable, ASAR and (for Codex) Chrome hashes. Temporary native probes check the connected Codex manager and Claude session methods. An idle Claude may receive a second-instance notification to wake its native callback.
- The validation runner delivers an initial challenge to Claude, routes Claude's explicit reply to Codex and routes the Codex reply back to Claude. The chats use their installed MCP tools. Each of three legs requires the exact recipient's `bridge_ack`, a fresh completed native turn and its unique final marker. The first two also require `bridge_reply` to the original message ID with the expected text. Validation traffic has a run-scoped receipt lane and does not wake production chats through the normal queue.
- The automatically created test chats also provide the native ID and workspace evidence for the creation capability. Codex permission validation uses its new idle chat to switch next-turn settings from read-only to workspace-write and back, with on-request approval and native readback. A diagnostic run with explicit IDs creates separate fixtures for those checks. Test chats and reports are retained for inspection. Claude has no managed Codex sandbox-policy endpoint.
- Codex MCP reload is global. Every loaded chat must be idle and there must be no protected chats. The runner checks the tool catalog and calls `bridge_self` from the designated chat after reload. Claude reconnects desktop-bridge only in its designated idle chat and reads the native server status. A queued request or a server requiring user connection cannot earn the capability.
- Each package declares only its passed capabilities under `runtime/candidates`. The report records individual failures and deferrals. Generated Codex packages support read-only creation, or workspace-write if permission validation also passed. These modes require on-request approval and no extra writable roots. With permission validation passed, a local operator can set `allowFullAccess: true` in the Bridge execution policy settings. Explicit requests for `danger-full-access` and `never` then require native next-turn permission readback before sending work. Older known profiles keep their original policies. Import requires a bridge that understands core API v2.
- Inspect `runtime/router/canary/<runId>/report.json` for the failed step or linked message and native turn IDs. Automatic validation records each fingerprint pair before dispatch and attempts it only once, including across console restarts. On timeout, concurrent input or a crash, inspect the report and dedicated chat before manually starting another run. A desktop update during the test invalidates the result.
- Profiles and evidence are local. This workflow does not publish packages to the shared catalog or npm.
