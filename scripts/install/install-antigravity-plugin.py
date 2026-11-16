"""Install the desktop-bridge MCP server into Antigravity 2.0 as a managed plugin.

Antigravity launches one stdio MCP server for all chats and passes the calling
conversation in tools/call params._meta. The optional PreToolUse hook
(--identity-hook) is a fallback for builds that omit that metadata.
"""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parent))
from bridge_paths import ROOT, source_file
import argparse
import datetime
import hashlib
import json
import shutil
from pathlib import Path

import bridge_skill

PLUGIN = 'desktop-agent-bridge'
SERVER = 'desktop-bridge'
MARKER = '.desktop-bridge-managed'
HOOK_FILES = ['antigravity-hook.mjs', 'antigravity-binding.mjs']
MANAGED = {'plugin.json', 'mcp_config.json', 'hooks.json', 'hook-config.json', MARKER, *HOOK_FILES, 'skills'}
# Antigravity loads skills/<name>/SKILL.md from plugins; the bridge owns only its own skill there.
SKILL_DIRECTORY = Path('skills') / bridge_skill.SKILL


def client_revision(root):
    return hashlib.sha256(b''.join(source_file(root, name).read_bytes() for name in
        ['peer-client.mjs', 'peer-catalog.mjs', 'peer-call.mjs', 'delegations.mjs'])).hexdigest()[:16]


def plugin_files(root, node, identity_hook):
    revision = client_revision(root)
    files = {
        'plugin.json': {'name': PLUGIN, 'displayName': 'Desktop Agent Bridge',
                        'description': 'Messages, replies and decisions between Antigravity, Codex, Claude and DeepSeek desktop chats.'},
        'mcp_config.json': {'mcpServers': {SERVER: {'command': node, 'args': [str(source_file(root, 'peer-client.mjs')), '--app', 'antigravity'],
                                                    'env': {'DESKTOP_BRIDGE_CLIENT_REVISION': revision}}}},
        MARKER: {'managedBy': 'desktop-agent-bridge', 'root': str(root), 'revision': revision, 'identityHook': identity_hook},
    }
    if identity_hook:
        files['hook-config.json'] = {'bindingsDirectory': str(root / 'runtime/antigravity/hook-bindings')}
        # Hooks run in the plugin folder through cmd /c; a relative script avoids path quoting.
        files['hooks.json'] = {'desktop-bridge-identity': {'PreToolUse': [{'matcher': 'call_mcp_tool',
            'hooks': [{'type': 'command', 'command': 'node antigravity-hook.mjs', 'timeout': 10}]}]}}
    return {name: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf8') for name, value in files.items()}


def install(root, home, node, identity_hook=False, runtime=None):
    root, home = Path(root), Path(home)
    runtime = Path(runtime) if runtime else root / 'runtime/antigravity'
    target = home / '.gemini/config/plugins' / PLUGIN
    if target.exists():
        if not (target / MARKER).exists():
            raise RuntimeError(f'{target} exists and is not managed by desktop-agent-bridge; refusing to replace it')
        unknown = sorted(path.name for path in target.iterdir() if path.name not in MANAGED)
        if (target / 'skills').exists():
            unknown += sorted('skills/' + path.name for path in (target / 'skills').iterdir() if path.name != bridge_skill.SKILL)
        if unknown:
            raise RuntimeError(f'Managed plugin folder contains unknown files {unknown}; inspect it before updating')
    files = plugin_files(root, node, identity_hook)
    if identity_hook:
        for name in HOOK_FILES:
            files[name] = source_file(root, name).read_bytes()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = None
    if target.exists():
        backup = runtime / 'plugin-backups' / stamp
        shutil.copytree(target, backup)
    target.mkdir(parents=True, exist_ok=True)
    for name in MANAGED - set(files) - {'skills'}:
        (target / name).unlink(missing_ok=True)
    for name, data in files.items():
        temporary = target / (name + '.desktop-bridge.tmp')
        temporary.write_bytes(data)
        temporary.replace(target / name)
    bridge_skill.write_skill(target / SKILL_DIRECTORY, bridge_skill.skill_files(root, stamp))
    proof = {'installedAt': stamp, 'plugin': str(target), 'server': f'{PLUGIN}_{SERVER}', 'identityHook': identity_hook,
             'backupDirectory': str(backup) if backup else None, 'clientRevision': client_revision(root),
             'skill': str(target / SKILL_DIRECTORY), 'skillRevision': bridge_skill.skill_revision(root)}
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / 'plugin-installation.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf8')
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identity-hook', action='store_true', help='also install the PreToolUse fallback identity hook')
    options = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required')
    print(json.dumps(install(ROOT, Path.home(), node, options.identity_hook), ensure_ascii=False))
