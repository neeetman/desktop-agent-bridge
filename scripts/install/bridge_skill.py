"""Install the desktop-bridge skill for Claude Code, Codex, DeepSeek Harness and Antigravity.

The skill holds the desktop communication guide. Each installed copy carries a
marker with the repository revision so drift (outdated or locally edited copies)
can be detected; the router keeps appending the fallback guide line for apps
whose copy is not current. src/mcp/bridge-skill.mjs reads the same layout.
"""
import datetime
import hashlib
import json
import os
import shutil
from pathlib import Path

from bridge_paths import source_file

SKILL = 'desktop-bridge'
MARKER = '.desktop-bridge-skill.json'
MANAGED_BY = 'desktop-agent-bridge'
# Codex (user-agent-skills) and DeepSeek Harness (user-agents) both read ~/.agents/skills.
APP_TARGET = {'claude': 'claude', 'codex': 'agents', 'deepseek': 'agents', 'antigravity': 'antigravity'}
TARGET_APPS = {key: [app for app, target in APP_TARGET.items() if target == key] for key in set(APP_TARGET.values())}


def skill_bytes(root):
    return source_file(root, 'desktop-bridge-skill.md').read_bytes()


def skill_revision(root):
    return hashlib.sha256(skill_bytes(root)).hexdigest()[:16]


def package_version(root):
    return json.loads((Path(root) / 'package.json').read_text(encoding='utf8'))['version']


def antigravity_plugin(home):
    return Path(home) / '.gemini/config/plugins/desktop-agent-bridge'


def targets(home, env=None):
    env = os.environ if env is None else env
    home = Path(home)
    claude_home = Path(env['CLAUDE_CONFIG_DIR']) if env.get('CLAUDE_CONFIG_DIR') else home / '.claude'
    return {'claude': claude_home / 'skills' / SKILL,
            'agents': home / '.agents/skills' / SKILL,
            'antigravity': antigravity_plugin(home) / 'skills' / SKILL}


def status(directory, revision):
    """missing | unmanaged | modified | outdated | current, same states as bridge-skill.mjs."""
    directory = Path(directory)
    skill = directory / 'SKILL.md'
    result = {'state': 'missing', 'path': str(directory), 'installedRevision': None}
    if not skill.exists():
        return result
    try:
        marker = json.loads((directory / MARKER).read_text(encoding='utf8'))
    except (OSError, ValueError):
        marker = None
    if not isinstance(marker, dict) or marker.get('managedBy') != MANAGED_BY:
        return {**result, 'state': 'unmanaged'}
    result.update(installedRevision=marker.get('revision'), installedAt=marker.get('installedAt'))
    if hashlib.sha256(skill.read_bytes()).hexdigest() != marker.get('sha256'):
        return {**result, 'state': 'modified'}
    return {**result, 'state': 'current' if marker.get('revision') == revision else 'outdated'}


def skill_files(root, stamp):
    data = skill_bytes(root)
    marker = {'managedBy': MANAGED_BY, 'skill': SKILL, 'revision': skill_revision(root),
              'sha256': hashlib.sha256(data).hexdigest(), 'packageVersion': package_version(root),
              'root': str(root), 'installedAt': stamp}
    return {'SKILL.md': data, MARKER: (json.dumps(marker, ensure_ascii=False, indent=2) + '\n').encode('utf8')}


def write_skill(directory, files):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        temporary = directory / (name + '.desktop-bridge.tmp')
        temporary.write_bytes(data)
        os.replace(temporary, directory / name)


def plan(root, home, keys=None, env=None):
    """Describe what install() would do, without writing anything."""
    revision = skill_revision(root)
    rows = []
    for key, directory in targets(home, env).items():
        if keys is not None and key not in keys:
            continue
        current = status(directory, revision)
        row = {'target': key, 'apps': sorted(TARGET_APPS[key]), 'path': str(directory), 'state': current['state'],
               'installedRevision': current['installedRevision'], 'revision': revision}
        if current['state'] == 'unmanaged':
            row['action'], row['reason'] = 'refuse', 'A skill with this name exists and is not managed by desktop-agent-bridge'
        elif key == 'antigravity' and not (antigravity_plugin(home) / '.desktop-bridge-managed').exists():
            row['action'], row['reason'] = 'skip', 'The managed Antigravity plugin is not installed'
        elif current['state'] == 'current':
            row['action'] = 'none'
        else:
            row['action'] = 'backup-and-replace' if current['state'] in ('modified', 'outdated') else 'create'
        rows.append(row)
    return {'skill': SKILL, 'revision': revision, 'packageVersion': package_version(root), 'targets': rows}


def install(root, home, keys=None, env=None, runtime=None):
    root, home = Path(root), Path(home)
    runtime = Path(runtime) if runtime else root / 'runtime'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    proposal = plan(root, home, keys, env)
    refused = [row for row in proposal['targets'] if row['action'] == 'refuse']
    if refused:
        raise RuntimeError('Refusing to replace unmanaged skills: ' + ', '.join(row['path'] for row in refused))
    files = skill_files(root, stamp)
    backup = runtime / 'skill-backups' / stamp
    for row in proposal['targets']:
        if row['action'] == 'backup-and-replace':
            shutil.copytree(row['path'], backup / row['target'])
            row['backupDirectory'] = str(backup / row['target'])
        if row['action'] in ('create', 'backup-and-replace'):
            write_skill(row['path'], files)
            row['state'] = 'current'
            row['installedRevision'] = proposal['revision']
    record_file = runtime / 'skills/installation.json'
    try:
        record = json.loads(record_file.read_text(encoding='utf8'))
    except (OSError, ValueError):
        record = {}
    record.setdefault('targets', {})
    for row in proposal['targets']:
        if row['state'] == 'current':
            record['targets'][row['target']] = {'path': row['path'], 'revision': proposal['revision'],
                                                'packageVersion': proposal['packageVersion'],
                                                'installedAt': stamp if row['action'] != 'none' else
                                                record['targets'].get(row['target'], {}).get('installedAt')}
    record.update(skill=SKILL, revision=proposal['revision'], updatedAt=stamp)
    record_file.parent.mkdir(parents=True, exist_ok=True)
    record_file.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    return proposal
