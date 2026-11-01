# Desktop Agent Bridge contributor rules

- This checkout is independent of capture/game projects. Keep machine state, credentials, extracted application code and live transcripts outside Git.
- Follow the subsystem layout under `src/`, `scripts/`, and `tests/`; keep the root for project metadata and language entrypoints. Update `src/layout.json` when moving logical sources and preserve self-contained adapter snapshots.
- The default README is English. Maintain the Chinese overview in README.zh-CN.md and keep public contribution/install instructions independent of the maintainer's machine.
- Only one installation may own the fixed ports, named pipes and user scheduled tasks. Do not switch a running installation's path as part of an unrelated source edit.
- Never print tokens from connection/callback files. Never replay unknown native outcomes automatically or answer permission prompts through peer decisions.
- Desktop application versions and hashes are compatibility gates. Do not claim support by changing a hash without verifying the native contract.
- Run `npm test`, `npm run test:python`, and `npm run check` for changes affecting deployment or communication. These are offline checks; do not launch apps, send messages, create GUI sessions or restart desktops as a test without task authorization.
- Keep critical threads protected. Refresh cached MCP workers/helpers only during an appropriate idle maintenance window.
- Preserve helper byte revisions; use `.gitattributes` line endings and check-source.mjs to validate them before committing.
- Do not add a remote, publish a repository, push, or select an open-source license without the owner's direction.
