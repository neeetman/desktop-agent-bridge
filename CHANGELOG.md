# Changelog

## 0.8.1 (unreleased)

- Organize runtime code by subsystem under `src/`, platform helpers under `scripts/`, and tests under `tests/`.
- Preserve self-contained compatibility snapshots through a shared logical source map.
- Make English the default README, retain the Chinese translation, and add contributor documentation.
- Update installer, supervision, MCP configuration, package contents, and source checks for the new layout. The public CLI command remains `desktop-agent-bridge`.

## 0.8.0

- P0: shared compatibility selection, running/installed build separation, process generations, typed pre-dispatch failures, revision-aware attachment monitors and native capability gates.
- P1: local profile catalog/import, immutable adapter snapshots, installation/helper bindings, persistent idle activation and crash recovery, compatible-build rollback, passive doctor and observed MCP worker revisions.
- Keep queued messages/decision answers during a verified update block; retain unknown outcomes without replay. Remove unconditional page reload recovery.
- MIT license and scoped npm package/CLI configuration. npm publication requires separate authentication; the live v0.7 installation is not migrated by this release.
