# Codex 26.1027.6604.0 contract validation

Validated locally on 2026-11-03 against the exact executable, chrome.dll and app.asar fingerprints registered in the profile. The application reports internal version 26.1027.51404; its Windows package version is 26.1027.6604.0.

Static inspection found the live connection module still at webpack ID 67295 in the renamed bootstrap chunk, and the conversation manager class changed from `_X` to `_2`. Isolated helpers confirmed the live constructor and manager. Native `tools/list` and `read_thread` succeeded. The managed session snapshot returned the expected model, cwd, sandbox and approval policy. `prepare` restored the existing saved policy and readback confirmed those permission values were unchanged. The MCP helper connected and returned `mcpServerStatus/list` data with zero reloads.

No game was started or captured for this bridge check. New conversation creation, changed permission values and global MCP reload were not exercised. Test credentials, extracted application code and detailed native results remain in ignored runtime storage.

Production recovery selected the new profile and attached the normal helpers after the desktop processes restarted. Both Codex and Claude passed authenticated service and native thread-list probes. An existing managed Codex chat was successfully woken through the durable peer router and explicitly acknowledged its recovery notification before submitting its original decision request again. No unknown native outcome was replayed.

A historical Claude task had been recorded as unknown when its WMI inventory subprocess failed. Review of the exact error and the historical lifecycle code established that it failed in compatibility resolution before the native pipe could connect or write. With the backend stopped and the native target confirmed idle, its local task record was reconciled to a failed, not-started outcome with a full state backup and audit note. Its original prompt was not replayed; later queued messages could proceed.

Offline validation: 120 Node tests, 18 Python tests, and the source/dependency/revision check passed. Desktop inventory coverage checks that lower-case Win32 executable basenames produce the same process identity as CIM spelling.
