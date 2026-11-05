# Changelog

## Unreleased

- Deliver messages, replies and decision questions into active chats using the native input path; waiting for a reply no longer blocks subsequent inputs.
- Keep native acceptance, explicit consumption and exact-message replies separate, including across service restarts. Preserve current model and permission settings for peer inputs.
- Recover Codex read circuits with rate-limited, generation-bound read probes, while keeping local receipts and independently gated sends available during a read failure.
- Distinguish version, contract and connection waits in the console. Expire known-unsent inputs at their original TTL rather than dispatching stale work after recovery.
- Filter supervisor process inventory in CIM and resolve the Windows session once, avoiding recovery shutdown caused by slow enumeration on desktops with many agent workers.
- Retire completed-task polling and prioritize pending Claude inputs over background reads; expired or disconnected queued calls cannot execute later.

## 0.8.4 — 2026-11-03

- Deliver peer notifications to idle chats paused on callback decisions without resolving the decision or completing its parent task.
- Discover desktops through Win32 instead of WMI and coalesce concurrent inventory queries; completed and failed inventories are not cached.
- Stop health notifications from waking archived chats and expire queued notices after unsubscribe.
- Forward task callbacks to their creating peer and prevent duplicate startups from overwriting live connection files.

## 0.8.3 — 2026-11-03

- Resume an explicitly linked callback decision through its durable continuation when a peer answer arrives, instead of blocking behind the paused task.
- Prioritize decision answers over unsent notifications, skip already answered queued requests, and preserve continuation identity across restarts without replaying unknown native outcomes.

## 0.8.2 — 2026-11-03

- Support the verified Claude 4.4212.0.0 Windows build and its session-manager worker PID contract.
- Pass the MCP server name when reconnecting Claude and surface native reconnect failures.
- Preserve registered builds and revocation flags when refreshing source revisions.


## Unreleased

- Exclude Claude CLI-local command records from model turns so delayed `/model` transcript entries cannot misidentify an accepted message as interrupted.
- Rehash native files after ctime-only metadata updates and preserve the live helper binding when every byte still matches; file replacements and changed content still require restart.
- Support the verified Codex 26.1027.6604.0 Windows package, including its renamed bootstrap chunk and conversation manager.
- Normalize desktop executable basename casing across Win32 and CIM inventory so one running process retains its helper binding.

- Block automatic launches and recovery when Windows process enumeration fails or omits the supervisor itself, preventing repeated GUI activation and duplicate service starts.

- Debounce health alerts until three consecutive failures spanning at least 60 seconds; retain confirmed state across router restarts.
- Coalesce per-app probes, save healthy peer results independently, and return pending status within 2.5 seconds when a native read is slow.
- Record service/native step budgets, elapsed time, error codes, and periodic diagnostic samples without retrying native writes.
- Document source-checkout deployment and the idle maintenance window required to migrate an existing v0.7 installation.

## 0.8.1 — 2026-11-01

- Organize runtime code by subsystem under `src/`, platform helpers under `scripts/`, and tests under `tests/`.
- Preserve self-contained compatibility snapshots through a shared logical source map.
- Make English the default README, retain the Chinese translation, and add contributor documentation.
- Update installer, supervision, MCP configuration, package contents, and source checks for the new layout. The public CLI command remains `desktop-agent-bridge`.

## 0.8.0

- P0: shared compatibility selection, running/installed build separation, process generations, typed pre-dispatch failures, revision-aware attachment monitors and native capability gates.
- P1: local profile catalog/import, immutable adapter snapshots, installation/helper bindings, persistent idle activation and crash recovery, compatible-build rollback, passive doctor and observed MCP worker revisions.
- Keep queued messages/decision answers during a verified update block; retain unknown outcomes without replay. Remove unconditional page reload recovery.
- MIT license and scoped npm package/CLI configuration. npm publication requires separate authentication; the live v0.7 installation is not migrated by this release.
