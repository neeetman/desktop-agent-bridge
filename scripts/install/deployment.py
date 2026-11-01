"""Initialize machine-local state and verify desktop bytes without attaching."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path




def initialize(root, home, writable_roots=(), protected_threads=()):
    allowed = []
    for value in writable_roots:
        path = Path(value)
        if not path.is_absolute() or not path.is_dir():
            raise ValueError(f'Writable root must be an existing absolute directory: {value}')
        real = str(path.resolve())
        if real not in allowed:
            allowed.append(real)
    settings = home / '.desktop-session-bridge' / 'settings.json'
    requested = {'allowedWritableRoots': allowed, 'defaultSandboxMode': 'workspace-write',
                 'defaultApprovalPolicy': 'on-request'}
    had_settings = settings.exists()
    if had_settings:
        existing = json.loads(settings.read_text(encoding='utf-8-sig'))
        if not isinstance(existing.get('allowedWritableRoots'), list):
            raise ValueError('Existing local settings are invalid; inspect them before installing')
        if allowed and existing['allowedWritableRoots'] != allowed:
            raise ValueError('Existing writable-root policy differs; edit local settings explicitly')
    protected = root / 'runtime' / 'router' / 'protected-threads.json'
    before = json.loads(protected.read_text(encoding='utf-8-sig')) if protected.exists() else {'threadIds': []}
    if not isinstance(before.get('threadIds'), list):
        raise ValueError('Invalid protected thread configuration')
    ids = list(dict.fromkeys([*before['threadIds'], *protected_threads]))
    if any(not isinstance(value, str) or not value.strip() for value in ids):
        raise ValueError('Protected thread IDs must be nonempty strings')
    # All inputs are checked before creating machine-local files. Never reset thread policies.
    for name in ('router', 'supervisor', 'claude-relay', 'claude-attach', 'codex-mcp'):
        (root / 'runtime' / name).mkdir(parents=True, exist_ok=True)
    if not settings.exists():
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps(requested, indent=2) + '\n', encoding='utf-8')
    if not protected.exists() or ids != before['threadIds']:
        before['threadIds'] = ids
        temporary = protected.with_suffix('.tmp')
        temporary.write_text(json.dumps(before, indent=2) + '\n', encoding='utf-8')
        os.replace(temporary, protected)
    return {'settingsFile': str(settings), 'protectedThreadsFile': str(protected),
            'existingSettingsPreserved': had_settings}


def check_compatibility(root, codex_executable, claude_executable):
    if (root / 'compat/catalog.json').exists():
        files = []
        for app, executable in [('codex', codex_executable), ('claude', claude_executable)]:
            result = subprocess.run(['node', str(source_file(root, 'compat-service.mjs')), 'check-build'],
                                    input=json.dumps({'app': app, 'executable': str(executable)}),
                                    capture_output=True, text=True, timeout=30,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            value = json.loads(result.stdout)
            if result.returncode or value.get('error'):
                raise ValueError(value.get('error', 'Compatibility coordinator failed'))
            files.append(value)
        return {'validated': True, 'attached': False, 'apps': files}
    files = []
    for name, executable, manifest_names in (
        ('codex', codex_executable, ('codex-execution-compatibility.json', 'codex-mcp-compatibility.json')),
        ('claude', claude_executable, ('claude-attach-compatibility.json',)),
    ):
        executable = Path(executable)
        actual_files = {'executableSha256': executable,
                        'asarSha256': executable.parent / 'resources' / 'app.asar'}
        if name == 'codex':
            actual_files['chromeSha256'] = executable.parent / 'chrome.dll'
        hashes = {}
        for key, file in actual_files.items():
            with file.open('rb') as stream:
                hashes[key] = hashlib.file_digest(stream, 'sha256').hexdigest()
        for manifest_name in manifest_names:
            manifest = json.loads(source_file(root, manifest_name).read_text(encoding='utf-8'))
            for key, actual in hashes.items():
                if actual != manifest[key]:
                    raise ValueError(f'Unsupported {name} build: {actual_files[key]}; '
                                     f'expected={manifest[key]}; actual={actual}; manifest={manifest_name}')
        files.append({'app': name, 'executable': str(executable), 'hashesValidated': True})
    return {'validated': True, 'attached': False, 'apps': files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('initialize')
    init.add_argument('--writable-root', action='append', default=[])
    init.add_argument('--protected-thread', action='append', default=[])
    check = sub.add_parser('check')
    check.add_argument('--codex-executable', required=True, type=Path)
    check.add_argument('--claude-executable', required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'initialize':
        result = initialize(ROOT, Path.home(), args.writable_root, args.protected_thread)
    else:
        result = check_compatibility(ROOT, args.codex_executable, args.claude_executable)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
