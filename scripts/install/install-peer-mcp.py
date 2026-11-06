"""Merge one MCP entry, preserving other settings and backing up existing files."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import datetime
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tomllib


def install(root, home, codex_home, node):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = root / 'runtime' / 'mcp-config-backups' / stamp
    revision = hashlib.sha256(b''.join(source_file(root, name).read_bytes() for name in
        ['peer-client.mjs', 'peer-catalog.mjs', 'peer-call.mjs', 'delegations.mjs'])).hexdigest()[:16]
    spec = {'type': 'stdio', 'command': node, 'args': [str(source_file(root, 'peer-client.mjs'))],
            'env': {'DESKTOP_BRIDGE_CLIENT_REVISION': revision}}
    codex, claude = codex_home / 'config.toml', home / '.claude.json'
    codex_before = codex.read_text(encoding='utf-8-sig') if codex.exists() else None
    claude_source = claude.read_text(encoding='utf-8-sig') if claude.exists() else None
    codex_source = codex_before or ''
    codex_data = tomllib.loads(codex_source)
    claude_data = json.loads(claude_source) if claude_source is not None else {}
    block = '\n'.join(['[mcp_servers.desktop-bridge]', f'command = {json.dumps(node)}',
        f'args = {json.dumps(spec["args"])}',
        f'env = {{ DESKTOP_BRIDGE_CLIENT_REVISION = {json.dumps(revision)} }}',
        'enabled = true', 'startup_timeout_sec = 20', 'tool_timeout_sec = 90', ''])
    pattern = r'(?ms)^\[mcp_servers\.desktop-bridge\]\r?\n.*?(?=^\[|\Z)'
    updated_codex = re.sub(pattern, lambda _: block + '\n', codex_source) if re.search(pattern, codex_source) else codex_source.rstrip() + '\n\n' + block
    parsed = tomllib.loads(updated_codex)
    def unrelated(value):
        copy = dict(value)
        copy['mcp_servers'] = {k: v for k, v in copy.get('mcp_servers', {}).items() if k != 'desktop-bridge'}
        return copy
    if unrelated(parsed) != unrelated(codex_data):
        raise ValueError('Unrelated Codex configuration would change; inspect the MCP table format')
    claude_data.setdefault('mcpServers', {})['desktop-bridge'] = spec
    updated_claude = json.dumps(claude_data, ensure_ascii=False, indent=2) + '\n'
    # All config parsing completes before either live config is written.
    backup.mkdir(parents=True, exist_ok=True)
    for file, filename in [(codex, 'codex-config.toml'), (claude, 'claude.json')]:
        if file.exists():
            shutil.copy2(file, backup / filename)
    def replace_if_unchanged(file, before, after):
        current = file.read_text(encoding='utf-8-sig') if file.exists() else None
        if current != before:
            raise RuntimeError(f'Configuration changed concurrently: {file.name}; rerun after saving')
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_name(file.name + '.desktop-bridge.tmp')
        temporary.write_text(after, encoding='utf-8')
        os.replace(temporary, file)
    replace_if_unchanged(codex, codex_before, updated_codex)
    replace_if_unchanged(claude, claude_source, updated_claude)
    db = home / '.cc-switch/cc-switch.db'
    registry = False
    registry_note = None
    if db.exists():
        with closing(sqlite3.connect(str(db))) as connection:
            with closing(sqlite3.connect(str(backup / 'cc-switch.db'))) as snapshot:
                connection.backup(snapshot)
            columns = {row[1] for row in connection.execute('PRAGMA table_info(mcp_servers)')}
            values = {'id': 'desktop-bridge', 'name': 'Desktop Agent Bridge', 'server_config': json.dumps(spec),
                      'description': 'Desktop agent messaging and asynchronous decisions', 'tags': '[]',
                      'enabled_claude': 1, 'enabled_codex': 1, 'enabled_gemini': 0,
                      'enabled_opencode': 0, 'enabled_hermes': 0}
            required = {'id', 'name', 'server_config', 'enabled_claude', 'enabled_codex'}
            if required <= columns:
                names = [name for name in values if name in columns]
                updates = [name for name in ('name', 'server_config', 'description', 'enabled_claude', 'enabled_codex') if name in columns]
                connection.execute('INSERT INTO mcp_servers (' + ','.join(names) + ') VALUES (' +
                    ','.join('?' for _ in names) + ') ON CONFLICT(id) DO UPDATE SET ' +
                    ','.join(f'{name}=excluded.{name}' for name in updates), [values[name] for name in names])
                connection.commit()
                registry = True
            else:
                registry_note = 'Unknown cc-switch schema; registry skipped, direct MCP configs installed'
    proof = {'installedAt': stamp, 'files': [str(codex), str(claude)], 'backupDirectory': str(backup),
             'ccSwitchRegistered': registry, 'ccSwitchNote': registry_note, 'server': 'desktop-bridge', 'serverSpec': spec}
    directory = root / 'runtime/router'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'config-installation.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
    return {key: proof[key] for key in ('server', 'ccSwitchRegistered', 'ccSwitchNote', 'backupDirectory')}


if __name__ == '__main__':
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required')
    home = Path.home()
    print(json.dumps(install(ROOT, home,
        Path(os.environ.get('CODEX_HOME', home / '.codex')), node), ensure_ascii=False))
