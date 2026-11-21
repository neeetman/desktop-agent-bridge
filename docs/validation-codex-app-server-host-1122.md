# Codex 26.1117 app server host, 2026-11-22

Codex 26.1117.4957.0 moved the app server connection and the conversation manager out of the Electron main process. The main process now runs `utilityProcess.fork("app-server-host.js")` (service name "App server host"). That utility process is the parent of `codex.exe app-server`, and main talks to it over a `MessageChannelMain`.

Certification of this build had failed at discovery with "found 0 matches for manager", for two reasons:

- The `AppServerConnection` class (`aP`, module 19229) is now in `app-server-host.js`. The main bundle only has a proxy class (`RE`) whose members are mostly class fields.
- The conversation manager (`_r`, module 13994) is constructed only in the host process. Its listener methods (`addConversationStateCallback`, `addApprovalRequestListener`) moved to a base class, so the old single-class signature no longer matches.

## What changed in the bridge

- `locate()` recognises the host layout. When the connection is in `app-server-host.js`, it looks for the manager in that same bundle, using a signature that allows inherited listeners, and records `host: "app-server-host"`.
- A manifest's `host` field names the process a helper must run in. `desktop_inventory.py` resolves the host PID as the main process's NodeService utility child that owns `codex.exe app-server`.
- The helpers and the canary probe check that they run in the process their manifest names. They no longer depend on Electron's `app` object, and they can find the manager class through the closures of its module's exports, not only through the connection's `getStatsigEvaluations` option.
- Catalog profile `codex-26.1117.4957.0-8a437aad94098770` matches the installed bytes. With it, read and send through the desktop native pipe work again: `bridge_health` reports `native_threads` ok.

## Open: injected helpers on this build

The native injector evaluates helper code from a Node-API callback, so it needs an addon's `napi_env`. The app server host loads no native addon (`better-sqlite3` is a lazy external that ordinary use does not load), so an attach there never evaluates. The attach scripts and the monitor refuse host manifests with `HOST_INJECTION_UNAVAILABLE`, so they no longer attach Frida to the process that hosts every chat.

Until the helpers move, create, permissions, full access and MCP refresh are unavailable on this build. The route found statically: main keeps a manager registry. `managers.getCurrent("local").resource.control.openClient()` returns an RPC stub of the host's per-client facade (`ul`), which exposes `startConversation`, `resumeConversation`, `getConversation`, `getThreadExecutionState`, `readThread`, `updateThreadSettingsForNextTurn`, `setThreadTitle` and `subscribe`. Main itself uses this stub. Porting the helpers to call it from main still needs live validation.
