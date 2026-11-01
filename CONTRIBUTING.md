# Contributing

Desktop Agent Bridge is an independent, MIT-licensed open-source project. Issues and pull requests are welcome at [the GitHub repository](https://github.com/neeetman/desktop-agent-bridge).

## Development environment

Use Node.js 24+ and Python 3.11+. The offline tests do not require installed desktop applications or a live Frida attachment. To work on a Windows desktop adapter, install the exact application build listed in the compatibility catalog and the pinned dependencies in `requirements.txt`.

Run from the repository root:

```powershell
npm ci
npm test
npm run test:python
npm run check
```

Keep source in the matching directory under `src/`, platform helpers under `scripts/`, and tests under `tests/node` or `tests/python`. Use `src/lib/paths.mjs` or `scripts/lib/bridge_paths.py` to resolve source files and machine-local runtime paths. Update `src/layout.json` when moving an executable helper or a logical adapter source.

## Changes to native adapters

Private desktop interfaces can change without notice. A compatibility profile must bind the exact application hashes, adapter bytes, capabilities, and evidence. Do not declare a build compatible merely by updating its hash.

`npm run source:refresh` refreshes digests of this project's own adapter code against the existing baseline manifests. It does not discover or approve a new desktop build. Run `npm run check` afterward.

Keep compatibility bundles self-contained. Immutable snapshots use logical source names, while the repository uses `src/layout.json` to find the physical files. DeepSeek Host releases also rewrite their few shared imports into a self-contained release directory.

Live tests must use explicitly authorized test sessions. Do not send unsolicited messages, create chats, restart desktops, refresh active workers, answer approval prompts, or change a production session's permissions as part of an offline test. Protect active work, preserve unknown outcomes, and report live-validation gaps honestly.

## Pull requests

Explain the user-visible problem, the resulting behavior, and relevant validation. Include regression coverage for protocol, queue, lifecycle, permission, or installation changes. For an application update, state which capabilities were tested and which remain blocked.

Keep credentials, runtime state, extracted application bundles, and real chat transcripts out of patches. Use synthetic or redacted protocol fixtures. Do not hard-code contributor-specific directories or session IDs.

## Documentation and releases

The default README is English; maintain the Chinese translation in `README.zh-CN.md`. Label documentation that is available only in another language.

Review `npm pack --dry-run` before a release. The public package must contain the CLI, production sources, installation helpers, profiles, license, and documentation, while excluding tests, developer state, credentials, and extracted application files. Publishing requires the maintainer's npm authentication and any required 2FA verification.

Contributions are provided under the repository's [MIT license](LICENSE).
