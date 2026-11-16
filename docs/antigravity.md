# Antigravity 2.0 desktop

Antigravity is the fourth app beside Codex, Claude and DeepSeek. The adapter uses no injection and no Frida. It talks to the
running desktop through the files and the CLI that Antigravity ships, and it is gated by contract probes rather than binary
hashes.

```text
Antigravity chat ── stdio MCP (peer-client.mjs --app antigravity) ──► peer-router :43130
                                                                          │
                                       antigravity-bridge.mjs :43134 ◄────┘
                                          │ reads                     │ writes
              ~/.gemini/antigravity/conversation_summaries.db        language_server.exe agentapi
              ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript*.jsonl
                                                                     ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN
                                                                     from ~/.gemini/antigravity/daemon/hub_<port>.json
```

| Source | Role |
|---|---|
| `src/adapters/antigravity/antigravity-native.mjs` | Hub discovery, `agentapi` runner, index and transcript readers, turn mapping, contract probes, doctor |
| `src/adapters/antigravity/antigravity-bridge.mjs` | Backend HTTP service on `127.0.0.1:43134` (state in `runtime/antigravity/`) |
| `src/adapters/antigravity/antigravity-hook.mjs`, `antigravity-binding.mjs` | Optional PreToolUse fallback identity hook |
| `scripts/install/install-antigravity-plugin.py` | Installs the managed Antigravity plugin `desktop-agent-bridge` |

## Live hub

The Language Server Hub writes `~/.gemini/antigravity/daemon/hub_<port>.json` with `pid`, `httpPort`, `httpsPort`,
`csrfToken` and `lsVersion`. Files of exited hubs remain on disk. The adapter takes the newest file (by modification time)
whose process is alive and whose `GET http://localhost:<httpPort>/healthz` returns 200.

The CSRF token is never printed, logged or put on a command line. It is held as a non-enumerable property and passed to
`agentapi` only through the child environment (`ANTIGRAVITY_LS_ADDRESS=localhost:<port>`, `ANTIGRAVITY_CSRF_TOKEN`).
`agentapi` error text is redacted before it is reported.

## Operations

| Bridge operation | Native call |
|---|---|
| list threads | `conversation_summaries` (opened read-only, `mode=ro`), `killed = 0 AND nesting_depth = 0`, newest first |
| read thread | `brain/<id>/.system_generated/logs/transcript.jsonl`, read backwards from the end; steps listed in `truncated_fields` are restored from `transcript_full.jsonl` |
| settings | `agentapi get-conversation-metadata <id>` (workspaces, root/parent conversation, planner model); index row when the desktop is closed |
| messages, wake | `agentapi send-message --title="Desktop bridge" <id> <content>`: wakes an idle chat and queues into a working one |
| create task | `agentapi new-conversation [--model=..] [--title=..] -- <prompt>`; the `--` keeps a prompt that starts with `-` from being read as a flag |
| projects | `~/.gemini/config/projects/<id>.json` (sidecar projects omitted) |
| models | tiers `flash_lite`, `flash`, `pro`, or any model ID; Antigravity runs an unavailable model ID on the flash tier |

Limits of the native CLI:

- `new-conversation` cannot choose a project or workspace. A task with `projectId` is rejected before dispatch; tasks
  create projectless chats.
- Reasoning effort is not selectable and an existing chat keeps its model. `effort`, or `model` on a send, is rejected
  before dispatch.
- Windows limits a command line to 32767 characters. A message longer than 24000 characters is written to
  `runtime/antigravity/long-messages/<sha>.md`; the chat receives the beginning of the text and the path of the full file.

### Turns

Antigravity has no turn objects. The adapter derives them from transcript steps:

- Every `USER_INPUT` step starts a turn.
- A message delivered by `send-message` appears as a `SYSTEM_MESSAGE` step with
  `[Message] timestamp=.. sender=.. priority=.. content=..`. It starts a turn when it arrives after the agent finished its
  run (that message woke the chat). A message that arrives during a run stays in the current turn.
- A message from the chat's own background task (`sender=<chat id>/task-N`) continues the turn that started the task. Long
  commands run as background tasks: the model may end its run with an interim reply and resume when the task completes.
- A turn completes on a `PLANNER_RESPONSE` without tool calls; that reply is the turn's `final_answer`. `ERROR_MESSAGE` fails it.
- The last turn is in progress while the index reports `CASCADE_RUN_STATUS_RUNNING` or `not_fully_idle` (background tasks
  pending), and for 10 seconds after its last step while the index catches up.

A chat that `new-conversation` just created can be missing from the index for a moment; reads and sends then confirm it
through `get-conversation-metadata`.

## When Antigravity is closed

Reads keep working from the local files. Writes check the contract and the hub before dispatch. With no live hub, the
backend answers 503 `APP_NOT_RUNNING` with `dispatchNotStarted`, and the router keeps the message in its persistent queue as
`waiting_for_connection` until the hub is back or the message TTL elapses. An `agentapi` failure that may have reached the
hub (timeout, unknown error) is reported as an unknown outcome and is never replayed.

The supervisor runs the bridge service only. It never launches, restarts or closes the Antigravity desktop.

## Sender identity

The bridge is cross-app only: Antigravity to Antigravity sends, decisions and task creation are rejected with
`SAME_APP_FORBIDDEN`; chats in the same app use Antigravity's own `send_message`.

Antigravity starts one stdio MCP server for all chats, so the server process cannot know the chat from its environment.
Each `tools/call` carries the calling chat in `params._meta`:

```json
{"antigravity.google/conversation_id": "<chat id>", "antigravity.google/root_conversation_id": "<root chat id>"}
```

`peer-client.mjs` reads `antigravity.google/conversation_id` first (evidence `MCP-call-metadata`). A model-reported
`fromThreadId` that disagrees is rejected, and a `fromThreadId` used without verified evidence never carries an owner
delegation.

For a future build that omits `_meta`, the plugin can also install a PreToolUse hook (`--identity-hook`). Antigravity runs
MCP calls as the native tool `call_mcp_tool`; the hook receives the true `conversationId` and records it, keyed by tool name
and canonical arguments, in `runtime/antigravity/hook-bindings/`. The MCP server consumes the single matching record within
30 seconds (evidence `antigravity-pretooluse-hook`). Two different chats issuing an identical call at once bind to neither.
The hook always answers `{"decision":"ask"}`, which defers to the user's own permission settings. Antigravity treats a hook
answer without a decision as a deny, and a failing hook command fails the tool step. The hook therefore prints a decision
on every path. It is off by default because each MCP call of every server then starts a Node process.

## Compatibility

`doctor --app antigravity` and every write check the native contract instead of file hashes:

- `language_server.exe agentapi --help` lists `send-message`, `new-conversation` and `get-conversation-metadata`, and
  `new-conversation` accepts `--model=`.
- `conversation_summaries` has the columns the adapter reads.
- The hub file and `/healthz` (reported separately: a closed desktop is not a contract failure).

A failed contract returns 503 `CONTRACT_MISMATCH` (router stage `waiting_for_contract`). Results are cached for ten minutes
per `language_server.exe` size and modification time.

```powershell
node bin/desktop-agent-bridge.mjs doctor --app antigravity
```

`phase` is `ready`, `app_not_running`, `contract_mismatch` or `not_installed`. The report also shows the bridge service
`/health` and whether recent Antigravity MCP calls carried `_meta` identity.

## Installation

```powershell
.\scripts\install.ps1 -CallerThread "<existing-codex-chat-id>" -WithAntigravity
# Optional fallback identity hook:
.\scripts\install.ps1 -CallerThread "<existing-codex-chat-id>" -WithAntigravity -AntigravityIdentityHook
```

The plugin is written to `~/.gemini/config/plugins/desktop-agent-bridge/` with a marker file. The installer refuses to
replace a folder it does not manage or one that contains unknown files, backs up the previous version to
`runtime/antigravity/plugin-backups/`, and records `runtime/antigravity/plugin-installation.json`. Antigravity loads the
plugin for new chats; its MCP server appears as `desktop-agent-bridge_desktop-bridge`. Turn the plugin off in Antigravity's
plugin settings, or delete its folder, to remove it.

## Validation (2026-11-16, Antigravity 44.9.1, Language Server 2.32.1)

Verified against the running desktop with dedicated test chats titled `desktop-bridge … (automated test)`:

- `_meta` carries `antigravity.google/conversation_id`; the hook payload carries `conversationId`, and a hook answer
  without a decision denied the call.
- Create: a projectless `flash` chat replied `ACK-CREATE-1` and the bridge task completed with that result.
- Wake: a tracked message to the idle chat opened a new turn and completed with `ACK-WAKE-2`.
- Queue into a working chat: a peer notification sent during a running command was accepted at once and steered the final
  reply (`ACK-BUSY-3 STEERED`). A background-task turn completed with its final answer (`ACK-BG-4`), not the interim reply.
- Router health probe through the backend: `service_http` and `native_threads` healthy.

Not validated live: delivery through the deployed router and MCP worker inside an Antigravity chat (requires deploying this
version), the hook fallback inside Antigravity, and queueing while the desktop is closed. Unit tests cover these paths.
