# Desktop Agent Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

An open-source, local session bridge for **Codex Desktop, Claude Code in Claude Desktop, and DeepSeek Harness on Windows**. Desktop agents can send messages, receive replies, request decisions, and wake the original session through MCP.

The project reuses native desktop sessions. It does not replace them with a separate Codex app-server. It depends on private desktop interfaces, so support is tied to verified application builds.

**License:** [MIT](LICENSE) · **npm:** [`@neeetman/desktop-agent-bridge`](https://www.npmjs.com/package/@neeetman/desktop-agent-bridge) · **Version:** 0.8.1

## Features

- Bidirectional messages, explicit receipts, replies, and asynchronous decisions.
- Multiple sessions, title search, exact session IDs, persistent queues, and automatic wake-up.
- Project/workspace selection and actual model, effort, and permission readback.
- Explicit full-access mode for supported, bridge-managed Codex sessions.
- Build verification, capability gates, local compatibility profiles, immutable adapter snapshots, idle activation, and compatible-build rollback.
- Per-user Windows logon startup and component recovery.

## Quick start

Install Node.js **24+**, Python **3.11+** with `pythonw.exe`, and the supported Codex and Claude Windows desktop packages. Sign in to both applications, keep Codex open, and select an existing Codex chat as the dispatcher.

From a fixed checkout directory:

```powershell
git clone https://github.com/neeetman/desktop-agent-bridge.git
cd desktop-agent-bridge
npm ci
python -m pip install -r requirements.txt

# Read-only checks: dependencies, desktop hashes, task ownership, and ports.
.\scripts\install.ps1 -CheckOnly

# Use this machine's chat ID and an existing local directory.
.\scripts\install.ps1 -CallerThread "<existing-codex-chat-id>" -WritableRoots "C:\Work"
```

The installer merges one `desktop-bridge` MCP entry, backs up existing configuration, and registers per-user startup and recovery tasks. It preserves other MCP servers and local execution policies. Add `-WithDeepSeek` after initializing the DeepSeek Harness desktop profile. Add `-ProtectedThreads @("<important-chat-id>")` to protect critical chats.

`-WritableRoots` controls additional writable directories; it is optional. The initial execution default is `workspace-write` with `on-request` approval. Full access requires an explicit request.

Check status and identify the current GUI session from each agent:

```powershell
npm run status
node bin/desktop-agent-bridge.mjs doctor
```

Then call `bridge_self`, search with `bridge_list_threads`, and address the verified `{toApp, toThreadId}`. Use dedicated test chats for the first round trip and decision request. A healthy HTTP process or an updated MCP config does not prove that an existing worker has loaded the current tools.

### npm distribution

The public package provides the same CLI and Windows installer:

```powershell
npm install -g @neeetman/desktop-agent-bridge
python -m pip install frida==17.9.1
desktop-agent-bridge doctor
desktop-agent-bridge install -CallerThread "<existing-codex-chat-id>" -WritableRoots "C:\Work"
```

Installing the npm package alone does not start applications or modify MCP configuration. Keep the installation directory fixed while services are running. See [publishing and distribution](docs/npm-release.md) for release status and maintenance steps. The repository may contain changes for the next npm release.

## Verified desktop builds

| Application | Build | Verification |
|---|---|---|
| Codex Desktop, Windows x64 | `26.1027.3384.0` | EXE, chrome.dll, and app.asar hashes |
| Claude Desktop, Windows x64 | `4.29.0` | EXE and app.asar hashes |
| DeepSeek Harness | `0.2.1-rc.3` | Native Cordis Host plugin contract |

Frida is pinned to **17.9.1**. Unknown Codex/Claude bytes are rejected. Updating a version string or hash alone does not establish compatibility.

## Repository layout

```text
bin/                    Stable command-line entry point
src/
  core/                 HTTP tasks, contracts, signals, execution policy
  adapters/             Codex, Claude, and DeepSeek native integrations
  mcp/                  MCP clients, tool catalog, message/decision router
  compat/               Build selection, helper identity, activation/recovery
  supervisor/           Windows service supervision and recovery policy
  cli/                  CLI commands
  lib/                  Shared project/source path resolution
  layout.json           Logical adapter names → physical source paths
scripts/
  *.ps1                 Windows installation and service commands
  install/              Configuration and deployment helpers
  runtime/              Native attachment and process helpers
  maintenance/          State retention and archival
  dev/                  Source verification and test runners
  lib/                  Shared Python path resolution
compat/                 Verified profiles, schemas, and baseline manifests
tests/                  Offline Node and Python tests
docs/                   Architecture, operations, and release guidance
```

`runtime/`, local credentials, logs, extracted application code, and installed dependencies are excluded from Git and npm. Logical adapter names remain stable so immutable compatibility packages can stay self-contained across repository moves.

## Development

```powershell
npm ci
npm test
npm run test:python
npm run check
```

These checks use simulated native connections and temporary files; they do not send messages to real desktop chats. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow, compatibility evidence, and publishing rules.

## Documentation

- [Repository architecture](docs/architecture.md) — Chinese
- [MCP messages, replies, decisions, and permissions](docs/peer-mcp.md) — Chinese
- [Deployment](docs/deployment.md) and [logon startup](docs/autostart.md) — Chinese
- [Update operations](docs/update-operations.md) and [update design](docs/update-resilience.md) — Chinese
- [Migration](docs/migration.md), [validation scope](docs/validation.md), and [npm releases](docs/npm-release.md) — Chinese
- [Changelog](CHANGELOG.md)

The earlier live installation validated messaging and decisions. The newer update coordinator has offline integration coverage and passive desktop verification; a live helper upgrade, a second-machine cold install, and a full Windows reboot still require their own validation. Current limitations and evidence are recorded in [validation scope](docs/validation.md).
