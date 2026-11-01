import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from deployment import initialize, check_compatibility


class DeploymentTest(unittest.TestCase):
    def test_clean_install_and_reinstall_preserve_local_policy_and_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'checkout with spaces'
            home = Path(directory) / 'home'
            writable = Path(directory) / 'work'
            writable.mkdir()
            initialize(root, home, [str(writable)], ['protected'])
            settings = home / '.desktop-session-bridge/settings.json'
            self.assertEqual(json.loads(settings.read_text())['defaultSandboxMode'], 'workspace-write')
            local = {'allowedWritableRoots': [str(writable.resolve())], 'defaultSandboxMode': 'read-only', 'custom': 1}
            settings.write_text(json.dumps(local))
            threads = settings.parent / 'threads.json'
            threads.write_text('{"threads":{"keep":{}}}')
            initialize(root, home, [str(writable)], ['second'])
            self.assertEqual(json.loads(settings.read_text()), local)
            self.assertEqual(threads.read_text(), '{"threads":{"keep":{}}}')
            self.assertEqual(json.loads((root / 'runtime/router/protected-threads.json').read_text())['threadIds'], ['protected', 'second'])

    def test_invalid_or_conflicting_policy_does_not_create_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root, home = Path(directory) / 'repo', Path(directory) / 'home'
            with self.assertRaises(ValueError):
                initialize(root, home, ['relative'])
            self.assertFalse(root.exists())
            settings = home / '.desktop-session-bridge/settings.json'
            settings.parent.mkdir(parents=True)
            settings.write_text('{"allowedWritableRoots":[]}')
            with self.assertRaisesRegex(ValueError, 'differs'):
                initialize(root, home, [directory])
            self.assertFalse(root.exists())

    def test_both_codex_manifests_and_claude_hashes_are_checked_without_attachment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executables = []
            for app, manifests in [('codex', ['codex-execution-compatibility.json', 'codex-mcp-compatibility.json']),
                                   ('claude', ['claude-attach-compatibility.json'])]:
                base = root / app
                (base / 'resources').mkdir(parents=True)
                executable = base / 'app.exe'
                executable.write_bytes(app.encode())
                (base / 'chrome.dll').write_bytes(b'chrome')
                (base / 'resources/app.asar').write_bytes(b'asar')
                manifest = {key: hashlib.sha256(data).hexdigest() for key, data in
                            [('executableSha256', app.encode()), ('chromeSha256', b'chrome'), ('asarSha256', b'asar')]}
                for name in manifests:
                    (root / name).write_text(json.dumps(manifest))
                executables.append(executable)
            self.assertFalse(check_compatibility(root, *executables)['attached'])
            manifest_file = root / 'codex-mcp-compatibility.json'
            manifest = json.loads(manifest_file.read_text())
            manifest['executableSha256'] = 'invalid'
            manifest_file.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'codex-mcp-compatibility'):
                check_compatibility(root, *executables)


if __name__ == '__main__':
    unittest.main()
