# Windows desktop compatibility validation, 2026-11-04

Both local adapter directories were imported using the operator console. The running background monitors selected the exact executable and ASAR matches, with chrome.dll also matched for Codex. The console overview read both profile IDs from the coordinator. Live probes confirmed both helpers ready.

| Windows package | Contract checked |
|---|---|
| Codex 26.1029.7803.0 | Inspected the installed webpack chunks and resolved the connected local AppServerConnection in module 57757. Manager module 12179 contains the live Pg class. The execution helper found the local manager and the MCP helper reported connected. |
| Claude 4.16336.0.0 | Inspected the main session-manager export in index.chunk-N6aotG6D.js. The running Electron app reported version 4.16336.0. LocalSessions returned a session list and exposed getSession, start, sendMessage and transcript methods. The CLI worker PID resolved to the dedicated test session through cliPid. |

A real Codex chat sent an acceptance prompt to a dedicated Claude chat. Claude acknowledged the router message and sent a separate request to a dedicated Codex chat using MCP. Codex acknowledged that input and replied to its router message ID with the requested marker. Claude acknowledged the reply. All three acknowledgements had native turn IDs. The return request carried the optional task version in the text only. The check covered messaging and receipts on running desktops. Session creation, changes to permissions, and logon recovery were outside this run.
