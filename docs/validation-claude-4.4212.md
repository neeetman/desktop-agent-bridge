# Claude 4.4212 compatibility validation

Validated locally on 2026-11-03 against Windows Appx 4.4212.0.0, Electron app version 4.4212.0, using Frida 17.9.1 and the exact executable/ASAR fingerprints in the registered profile.

A separate canary helper and a dedicated empty workspace were used without restarting the desktop. Native `start` returned a new session ID. Both the initial prompt and a subsequent `sendMessage` returned the expected marker. `getSession`, `getSessionList`, `getTranscriptTail`, and `getTranscriptPage` returned usable records; turn parsing identified both completed inputs and their corresponding final answers.

The SDK transport process object no longer exposes `pid`. The session manager's `cliPid` matched the newly created CLI process and the helper resolved that PID to the dedicated session. The profile selects this field explicitly; older profiles retain their original identity contract.

Static inspection confirmed that `mcpReconnect` takes both session ID and server name. The CLI now passes an explicit server name (default `desktop-bridge`) and surfaces nested native errors instead of reporting success. Offline regression tests cover modern/legacy PID selection, ambiguous and missing identities, and reconnect errors.

Extracted application code, canary credentials and raw transcripts remain in ignored local runtime storage. This validation does not establish desktop restart/Windows logon recovery, permission changes, or model changes.

Deployment verification: both global MCP configurations and the cc-switch registry were merged with backups. All six enabled supervisor services reached healthy state. A dedicated Claude session invoked the actual MCP `bridge_self`; after stopping and warming only that idle test session, it reported worker version 0.8.2, client revision `fb54d968797a7957`, and its original session ID. A separately initialized Codex stdio MCP worker reported the same version and revision and identified the current Codex chat. Existing Codex GUI workers were not globally reloaded while protected chats were active.

Cold installation also exposed and fixed the Codex bootstrap credential ordering and Windows venv launcher/heartbeat PID selection. Final offline validation passed 106 Node tests, 15 Python tests, source-integrity checks and package creation.
