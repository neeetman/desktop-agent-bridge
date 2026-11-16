"""Merge one MCP entry, preserving other settings and backing up existing files."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parent))
from bridge_paths import ROOT
import datetime
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3

import mcp_config


def read_text(file):
    # Bytes keep CRLF line endings exactly; read_text would translate them.
    return file.read_bytes().decode('utf-8-sig') if file.exists() else None


def config_files(home, codex_home):
    return Path(codex_home) / 'config.toml', Path(home) / '.claude.json'


def plan_configs(root, home, codex_home, node):
    """Compute both updated configs without writing. Raises ValueError on unparsable configs."""
    codex, claude = config_files(home, codex_home)
    spec = mcp_config.server_spec(root, node)
    codex_before, claude_before = read_text(codex), read_text(claude)
    return {'spec': spec,
            'codex': (codex, codex_before, mcp_config.update_codex(codex_before or '', spec)),
            'claude': (claude, claude_before, mcp_config.update_claude(claude_before, spec))}


def cc_switch_plan(home, spec):
    """Return (database, needs_update, note, registered server_config) for the optional cc-switch registry."""
    db = Path(home) / '.cc-switch/cc-switch.db'
    if not db.exists():
        return db, False, None, None
    with closing(sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
        columns = {row[1] for row in connection.execute('PRAGMA table_info(mcp_servers)')}
        if not {'id', 'name', 'server_config', 'enabled_claude', 'enabled_codex'} <= columns:
            return db, False, 'Unknown cc-switch schema; registry skipped, direct MCP configs installed', None
        row = connection.execute('SELECT server_config FROM mcp_servers WHERE id=?', ['desktop-bridge']).fetchone()
    return db, (row is None or row[0] != json.dumps(spec)), None, row[0] if row else None


def install(root, home, codex_home, node, runtime=None):
    runtime = Path(runtime) if runtime else Path(root) / 'runtime'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = runtime / 'mcp-config-backups' / stamp
    # All config parsing completes before either live config is written.
    planned = plan_configs(root, home, codex_home, node)
    spec = planned['spec']
    backup.mkdir(parents=True, exist_ok=True)
    for name, filename in [('codex', 'codex-config.toml'), ('claude', 'claude.json')]:
        if planned[name][0].exists():
            shutil.copy2(planned[name][0], backup / filename)

    def replace_if_unchanged(file, before, after):
        if before == after:
            return
        if read_text(file) != before:
            raise RuntimeError(f'Configuration changed concurrently: {file.name}; rerun after saving')
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_name(file.name + '.desktop-bridge.tmp')
        temporary.write_text(after, encoding='utf-8', newline='')
        os.replace(temporary, file)
    for name in ('codex', 'claude'):
        replace_if_unchanged(*planned[name])
    db, _, registry_note, _ = cc_switch_plan(home, spec)
    registry = False
    if db.exists() and registry_note is None:
        with closing(sqlite3.connect(str(db))) as connection:
            with closing(sqlite3.connect(str(backup / 'cc-switch.db'))) as snapshot:
                connection.backup(snapshot)
            columns = {row[1] for row in connection.execute('PRAGMA table_info(mcp_servers)')}
            values = {'id': 'desktop-bridge', 'name': 'Desktop Agent Bridge', 'server_config': json.dumps(spec),
                      'description': 'Desktop agent messaging and asynchronous decisions', 'tags': '[]',
                      'enabled_claude': 1, 'enabled_codex': 1, 'enabled_gemini': 0,
                      'enabled_opencode': 0, 'enabled_hermes': 0}
            names = [name for name in values if name in columns]
            updates = [name for name in ('name', 'server_config', 'description', 'enabled_claude', 'enabled_codex') if name in columns]
            connection.execute('INSERT INTO mcp_servers (' + ','.join(names) + ') VALUES (' +
                ','.join('?' for _ in names) + ') ON CONFLICT(id) DO UPDATE SET ' +
                ','.join(f'{name}=excluded.{name}' for name in updates), [values[name] for name in names])
            connection.commit()
            registry = True
    proof = {'installedAt': stamp, 'files': [str(planned['codex'][0]), str(planned['claude'][0])], 'backupDirectory': str(backup),
             'ccSwitchRegistered': registry, 'ccSwitchNote': registry_note, 'server': 'desktop-bridge', 'serverSpec': spec}
    directory = runtime / 'router'
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
