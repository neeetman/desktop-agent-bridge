# Validating an unfamiliar desktop build

Open **适配管理 → 未知版本 · 生成与验收** in the console. Select the package to import and enter two exact, dedicated chat IDs. Both Windows desktops must be running, with desktop-bridge MCP already available in those chats. Keep the Codex test chat pinned or in recent chats. Choose an ordinary chat without a bridge-managed execution policy. Both chats must be idle and unprotected.

**开始验收** runs discovery and a live test. **检测到未知构建时自动验收** remembers the pair on this machine and checks once per minute while the console is running. The automatic check stages packages for review. Import a verified folder through **导入本机包**. Enable the console's Windows login preference to start monitoring after sign-in. A machine with no dedicated test pair starts with automatic validation disabled.

The equivalent CLI commands are:

```powershell
desktop-agent-bridge compat discover --app codex
desktop-agent-bridge compat certify --app claude --codex-thread <uuid> --claude-thread <local_uuid>
desktop-agent-bridge compat import <verified-package-directory>
```

- Discovery parses the installed ASAR without executing extracted bundles. It requires one structural match per required role, copies a digest-checked existing adapter and writes a quarantined `candidate.json`. An unsupported bundle layout, ambiguous matches, an unregistered version layout or a revoked fingerprint needs review.
- Validation binds to the running PIDs, their creation times and executable, ASAR and (for Codex) Chrome hashes. Temporary native probes check the connected Codex manager and Claude session methods. An idle Claude may receive a second-instance notification to wake its native callback.
- The validation runner delivers an initial challenge to Claude, routes Claude's explicit reply to Codex and routes the Codex reply back to Claude. The chats use their installed MCP tools. Each of three legs requires the exact recipient's `bridge_ack`, a fresh completed native turn and its unique final marker. The first two also require `bridge_reply` to the original message ID with the expected text. Validation traffic has a run-scoped receipt lane and does not wake production chats through the normal queue.
- A successful run writes a messaging-only package for each desktop under `runtime/candidates`. The CLI returns both paths. These packages cover reading and sending in existing chats. Managed execution, settings changes, session creation and global MCP reload require separate validation.
- Inspect `runtime/router/canary/<runId>/report.json` for the failed step or linked message and native turn IDs. Automatic validation records each fingerprint pair before dispatch and attempts it only once, including across console restarts. On timeout, concurrent input or a crash, inspect the report and dedicated chat before manually starting another run. A desktop update during the test invalidates the result.
- Profiles and evidence are local. This workflow does not publish packages to the shared catalog or npm.
