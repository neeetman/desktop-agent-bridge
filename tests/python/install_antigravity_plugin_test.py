import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from bridge_paths import ROOT, source_file

spec = importlib.util.spec_from_file_location('install_antigravity_plugin', source_file(ROOT, 'install-antigravity-plugin.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class AntigravityPlugin(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'home'
        self.runtime = Path(self.temp.name) / 'runtime'
        self.plugin = self.home / '.gemini/config/plugins/desktop-agent-bridge'

    def tearDown(self):
        self.temp.cleanup()

    def test_installs_mcp_server_without_hook_by_default(self):
        proof = installer.install(ROOT, self.home, 'node', runtime=self.runtime)
        config = json.loads((self.plugin / 'mcp_config.json').read_text(encoding='utf8'))
        server = config['mcpServers']['desktop-bridge']
        self.assertEqual(server['args'][-2:], ['--app', 'antigravity'])
        self.assertTrue(server['args'][0].endswith('peer-client.mjs'))
        self.assertEqual(server['env']['DESKTOP_BRIDGE_CLIENT_REVISION'], installer.client_revision(ROOT))
        self.assertFalse((self.plugin / 'hooks.json').exists())
        self.assertEqual(proof['server'], 'desktop-agent-bridge_desktop-bridge')
        self.assertTrue((self.runtime / 'plugin-installation.json').exists())

    def test_identity_hook_is_self_contained_and_removable(self):
        installer.install(ROOT, self.home, 'node', identity_hook=True, runtime=self.runtime)
        hooks = json.loads((self.plugin / 'hooks.json').read_text(encoding='utf8'))
        command = hooks['desktop-bridge-identity']['PreToolUse'][0]
        self.assertEqual(command['matcher'], 'call_mcp_tool')
        self.assertEqual(command['hooks'][0]['command'], 'node antigravity-hook.mjs')
        for name in ['antigravity-hook.mjs', 'antigravity-binding.mjs', 'hook-config.json']:
            self.assertTrue((self.plugin / name).exists(), name)
        self.assertNotIn('../', (self.plugin / 'antigravity-hook.mjs').read_text(encoding='utf8'))
        proof = installer.install(ROOT, self.home, 'node', runtime=self.runtime)
        self.assertFalse((self.plugin / 'hooks.json').exists())
        self.assertFalse((self.plugin / 'antigravity-hook.mjs').exists())
        self.assertTrue(Path(proof['backupDirectory'], 'hooks.json').exists())

    def test_never_replaces_an_unmanaged_or_modified_plugin(self):
        self.plugin.mkdir(parents=True)
        (self.plugin / 'plugin.json').write_text('{}', encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'not managed'):
            installer.install(ROOT, self.home, 'node', runtime=self.runtime)
        (self.plugin / installer.MARKER).write_text('{}', encoding='utf8')
        (self.plugin / 'user-notes.md').write_text('mine', encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'unknown files'):
            installer.install(ROOT, self.home, 'node', runtime=self.runtime)


if __name__ == '__main__':
    unittest.main()
