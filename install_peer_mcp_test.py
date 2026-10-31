import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-peer-mcp.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class McpInstallTest(unittest.TestCase):
    def fixture(self, directory):
        root, home = Path(directory) / 'checkout with spaces', Path(directory) / 'home'
        root.mkdir()
        for name in ('peer-client.mjs', 'peer-catalog.mjs', 'peer-call.mjs'):
            (root / name).write_text('// fixture')
        return root, home, home / '.codex'

    def test_first_install_creates_missing_user_configs(self):
        with tempfile.TemporaryDirectory() as directory:
            root, home, codex = self.fixture(directory)
            result = installer.install(root, home, codex, 'node.exe')
            data = tomllib.loads((codex / 'config.toml').read_text())
            self.assertEqual(data['mcp_servers']['desktop-bridge']['args'], [str(root / 'peer-client.mjs')])
            self.assertIn('desktop-bridge', json.loads((home / '.claude.json').read_text())['mcpServers'])
            self.assertFalse(result['ccSwitchRegistered'])

    def test_reinstall_preserves_unrelated_settings_and_supports_smaller_cc_switch_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root, home, codex = self.fixture(directory)
            codex.mkdir(parents=True)
            before = 'model = "keep-model"\n[mcp_servers.other]\ncommand = "keep"\n'
            (codex / 'config.toml').write_text(before)
            (home / '.claude.json').write_text(json.dumps({'custom': 3, 'mcpServers': {'other': {'command': 'keep'}}}))
            db = home / '.cc-switch/cc-switch.db'
            db.parent.mkdir()
            with closing(sqlite3.connect(db)) as connection:
                connection.execute('CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, server_config TEXT, enabled_claude INTEGER, enabled_codex INTEGER)')
            first = installer.install(root, home, codex, 'node.exe')
            self.assertEqual((Path(first['backupDirectory']) / 'codex-config.toml').read_text(), before)
            self.assertTrue(first['ccSwitchRegistered'])
            installer.install(root, home, codex, 'node.exe')
            data = tomllib.loads((codex / 'config.toml').read_text())
            self.assertEqual(data['model'], 'keep-model')
            self.assertEqual(data['mcp_servers']['other']['command'], 'keep')
            self.assertEqual((codex / 'config.toml').read_text().count('[mcp_servers.desktop-bridge]'), 1)
            self.assertEqual(json.loads((home / '.claude.json').read_text())['custom'], 3)
            with closing(sqlite3.connect(db)) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM mcp_servers').fetchone()[0], 1)

    def test_malformed_config_leaves_both_configs_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root, home, codex = self.fixture(directory)
            codex.mkdir(parents=True)
            config = codex / 'config.toml'
            config.write_text('model = "keep"\n')
            claude = home / '.claude.json'
            claude.write_text('malformed')
            with self.assertRaises(ValueError):
                installer.install(root, home, codex, 'node.exe')
            self.assertEqual(config.read_text(), 'model = "keep"\n')
            self.assertEqual(claude.read_text(), 'malformed')


if __name__ == '__main__':
    unittest.main()
