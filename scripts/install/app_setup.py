"""Per-app MCP + skill setup: status, an exact preview of the changes, and apply.

`plan()` reads every config and returns, per app, the configured client revision
against the current one and the skill state, plus a list of changes with unified
diffs. Its `planId` is a digest of those changes; `apply(plan_id)` recomputes the
plan and refuses when it no longer matches what the user previewed. Nothing is
written by plan().
"""
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path

import bridge_skill
import mcp_config
from bridge_paths import source_file

APPS = ['codex', 'claude', 'antigravity', 'deepseek']


def _load(root, name, module):
    spec = importlib.util.spec_from_file_location(module, source_file(root, name))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def _installers(root):
    return (_load(root, 'install-peer-mcp.py', 'desktop_bridge_install_peer_mcp'),
            _load(root, 'install-antigravity-plugin.py', 'desktop_bridge_install_antigravity_plugin'))


def choose_node(configured, default):
    """Keep the node the configs already use while it exists; otherwise use the default."""
    return configured if configured and os.path.isfile(configured) else default


def _mcp_row(configured, current, file):
    if configured is None:
        return {'file': str(file), 'state': 'missing', 'configuredRevision': None, 'currentRevision': current}
    state = 'current' if configured.get('revision') == current else 'outdated'
    return {'file': str(file), 'state': state, 'configuredRevision': configured.get('revision'), 'currentRevision': current}


def plan(root, home, codex_home, default_node, env=None):
    root, home = Path(root), Path(home)
    installer, antigravity = _installers(root)
    current = mcp_config.client_revision(root)
    skill_rows = {row['target']: row for row in bridge_skill.plan(root, home, env=env)['targets']}
    codex_file, claude_file = installer.config_files(home, codex_home)
    apps, changes, errors = {}, [], []

    def configured(reader, file):
        try:
            return reader(installer.read_text(file)), None
        except ValueError as error:
            return None, f'{file}: {error}'

    codex_cfg, codex_error = configured(mcp_config.configured_codex, codex_file)
    claude_cfg, claude_error = configured(mcp_config.configured_claude, claude_file)
    node = choose_node((codex_cfg or {}).get('command') or (claude_cfg or {}).get('command'), default_node)
    apps['codex'] = {'mcp': _mcp_row(codex_cfg, current, codex_file)}
    apps['claude'] = {'mcp': _mcp_row(claude_cfg, current, claude_file)}
    for app, error in (('codex', codex_error), ('claude', claude_error)):
        if error:
            apps[app]['mcp'].update(state='unreadable', error=error)
            errors.append(error)
    if not errors:
        try:
            planned = installer.plan_configs(root, home, codex_home, node)
            for app in ('codex', 'claude'):
                file, before, after = planned[app]
                if before != after:
                    changes.append({'kind': 'mcp-config', 'app': app, 'path': str(file),
                                    'diff': mcp_config.unified_diff(file, before, after)})
            db, needs, note, registered = installer.cc_switch_plan(home, planned['spec'])
            if needs:
                pretty = lambda text: json.dumps(json.loads(text), ensure_ascii=False, indent=2) + '\n'
                changes.append({'kind': 'cc-switch', 'app': 'codex', 'path': str(db),
                                'summary': 'cc-switch 中的 desktop-bridge 登记同步为当前 MCP 配置（会先备份数据库）',
                                'diff': mcp_config.unified_diff(f'{db} mcp_servers[desktop-bridge].server_config',
                                                                pretty(registered) if registered else None,
                                                                pretty(json.dumps(planned['spec'])))})
            elif note:
                apps['codex']['mcp']['note'] = note
        except ValueError as error:
            errors.append(str(error))
            for app in ('codex', 'claude'):
                apps[app]['mcp'].update(state='unreadable', error=str(error))

    plugin = home / '.gemini/config/plugins' / antigravity.PLUGIN
    marker = plugin / antigravity.MARKER
    if marker.exists():
        mcp_file = plugin / 'mcp_config.json'
        try:
            installed = json.loads(mcp_file.read_text(encoding='utf8'))['mcpServers'][antigravity.SERVER]
            settings = json.loads(marker.read_text(encoding='utf8'))
            row = _mcp_row({'revision': (installed.get('env') or {}).get(mcp_config.REVISION_KEY)}, current, mcp_file)
            plugin_node = choose_node(installed.get('command'), node)
            files = antigravity.plugin_files(root, plugin_node, bool(settings.get('identityHook')))
            plugin_changes = []
            for name, data in files.items():
                file = plugin / name
                before = file.read_text(encoding='utf8') if file.exists() else None
                if name == antigravity.MARKER:
                    continue  # bookkeeping only; rewritten with the plugin
                if before != data.decode('utf8'):
                    plugin_changes.append(mcp_config.unified_diff(file, before, data.decode('utf8')))
            if plugin_changes:
                changes.append({'kind': 'antigravity-plugin', 'app': 'antigravity', 'path': str(plugin),
                                'diff': ''.join(plugin_changes), 'node': plugin_node,
                                'identityHook': bool(settings.get('identityHook'))})
            apps['antigravity'] = {'mcp': row}
        except (OSError, ValueError, KeyError) as error:
            apps['antigravity'] = {'mcp': {'file': str(mcp_file), 'state': 'unreadable', 'error': str(error),
                                           'configuredRevision': None, 'currentRevision': current}}
            errors.append(f'Antigravity plugin: {error}')
    else:
        apps['antigravity'] = {'mcp': {'file': str(plugin), 'state': 'not-installed', 'configuredRevision': None,
                                       'currentRevision': current}}
    # DeepSeek Harness loads the bridge as a Harness plugin (install-deepseek-plugin.py), not as MCP.
    apps['deepseek'] = {'mcp': {'state': 'not-applicable', 'configuredRevision': None, 'currentRevision': current}}

    for app in APPS:
        target = bridge_skill.APP_TARGET[app]
        skill = dict(skill_rows[target])
        apps[app]['skill'] = skill
    for key, row in skill_rows.items():
        if row['action'] in ('create', 'backup-and-replace'):
            changes.append({'kind': 'skill', 'target': key, 'apps': row['apps'], 'path': row['path'],
                            'action': row['action'], 'state': row['state'],
                            'installedRevision': row['installedRevision'], 'revision': row['revision']})
        elif row['action'] == 'refuse':
            errors.append(f"{row['path']}: {row['reason']}")
    for change in changes:
        if change['kind'] in ('mcp-config', 'antigravity-plugin'):
            apps[change['app']]['mcp']['pending'] = True
        elif change['kind'] == 'cc-switch':
            for app in ('codex', 'claude'):
                apps[app]['mcp']['ccSwitchPending'] = True
    plan_id = hashlib.sha256(json.dumps(changes, sort_keys=True, ensure_ascii=False).encode('utf8')).hexdigest()[:16]
    return {'clientRevision': current, 'skillRevision': bridge_skill.skill_revision(root), 'node': node, 'home': str(home),
            'apps': apps, 'changes': changes, 'errors': errors, 'planId': plan_id}


def apply(root, home, codex_home, default_node, plan_id, env=None, runtime=None):
    root, home = Path(root), Path(home)
    runtime = Path(runtime) if runtime else root / 'runtime'
    proposal = plan(root, home, codex_home, default_node, env)
    if proposal['planId'] != plan_id:
        raise RuntimeError('Configuration changed since the preview; preview again before applying')
    if proposal['errors']:
        raise RuntimeError('; '.join(proposal['errors']))
    installer, antigravity = _installers(root)
    kinds = {change['kind'] for change in proposal['changes']}
    results = {}
    if kinds & {'mcp-config', 'cc-switch'}:
        results['mcp'] = installer.install(root, home, codex_home, proposal['node'], runtime)
    plugin = next((change for change in proposal['changes'] if change['kind'] == 'antigravity-plugin'), None)
    if plugin:
        results['antigravity'] = antigravity.install(root, home, plugin['node'], plugin['identityHook'], runtime / 'antigravity')
    targets = [change['target'] for change in proposal['changes'] if change['kind'] == 'skill']
    if targets:
        results['skill'] = bridge_skill.install(root, home, targets, env, runtime)
    after = plan(root, home, codex_home, default_node, env)
    return {'applied': len(proposal['changes']), 'results': results, 'status': after}


def default_node():
    return shutil.which('node')
