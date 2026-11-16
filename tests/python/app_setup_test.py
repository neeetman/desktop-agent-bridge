import json
import tempfile
import tomllib
import unittest
from pathlib import Path

import app_setup
import bridge_skill
import mcp_config
from bridge_paths import ROOT, source_file

CLIENT = str(source_file(ROOT, 'peer-client.mjs'))
REVISION = mcp_config.client_revision(ROOT)
SPEC = mcp_config.server_spec(ROOT, 'C:\\node\\node.exe')

# The layout Codex 26.1111 writes: an env sub-table and per-tool approval tables.
CODEX_CURRENT = '''model = "gpt"

[mcp_servers.desktop-bridge]
command = 'C:\\node\\node.exe'
args = ['D:\\old\\src\\mcp\\peer-client.mjs']
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 90

[mcp_servers.desktop-bridge.env]
DESKTOP_BRIDGE_CLIENT_REVISION = "0000000000000000"
OTHER = "keep"

[mcp_servers.desktop-bridge.tools.bridge_self]
approval_mode = "approve"

[mcp_servers.desktop-bridge.tools.bridge_ack]
approval_mode = "approve"

[mcp_servers.blender]
command = 'blender.exe'
'''


class CodexConfig(unittest.TestCase):
    def test_env_table_layout_changes_only_owned_lines(self):
        updated = mcp_config.update_codex(CODEX_CURRENT, SPEC)
        data = tomllib.loads(updated)
        entry = data['mcp_servers']['desktop-bridge']
        self.assertEqual(entry['args'], [CLIENT])
        self.assertEqual(entry['env'], {'DESKTOP_BRIDGE_CLIENT_REVISION': REVISION, 'OTHER': 'keep'})
        self.assertEqual(entry['tools'], {'bridge_self': {'approval_mode': 'approve'}, 'bridge_ack': {'approval_mode': 'approve'}})
        self.assertEqual(data['mcp_servers']['blender'], {'command': 'blender.exe'})
        diff = [line for line in mcp_config.unified_diff('c', CODEX_CURRENT, updated, 0).splitlines()
                if line[:1] in '+-' and not line.startswith(('+++', '---'))]
        self.assertEqual(len(diff), 4, diff)  # args and the revision line, nothing else
        self.assertIn("command = 'C:\\node\\node.exe'", updated)  # unchanged values keep their literal form
        self.assertEqual(mcp_config.update_codex(updated, SPEC), updated)

    def test_inline_env_crlf_and_multiline_args(self):
        source = ('[mcp_servers.desktop-bridge]\r\ncommand = "C:\\\\node\\\\node.exe"\r\nargs = [\r\n  "x\\\\peer-client.mjs",\r\n]\r\n'
                  'env = { DESKTOP_BRIDGE_CLIENT_REVISION = "0", KEEP = "1" }\r\n\r\n[other]\r\nvalue = 1\r\n')
        updated = mcp_config.update_codex(source, SPEC)
        self.assertNotIn('\n', updated.replace('\r\n', ''))
        entry = tomllib.loads(updated)['mcp_servers']['desktop-bridge']
        self.assertEqual(entry['args'], [CLIENT])
        self.assertEqual(entry['env'], {'DESKTOP_BRIDGE_CLIENT_REVISION': REVISION, 'KEEP': '1'})
        self.assertEqual(tomllib.loads(updated)['other'], {'value': 1})

    def test_missing_entry_is_appended_with_an_env_table(self):
        updated = mcp_config.update_codex('model = "gpt"\n', SPEC)
        data = tomllib.loads(updated)
        self.assertEqual(data['model'], 'gpt')
        self.assertEqual(data['mcp_servers']['desktop-bridge']['env']['DESKTOP_BRIDGE_CLIENT_REVISION'], REVISION)
        self.assertIn('[mcp_servers.desktop-bridge.env]', updated)

    def test_wrapped_launcher_is_kept(self):
        source = '[mcp_servers.desktop-bridge]\ncommand = "cmd"\nargs = ["/c", "node.exe", "D:/old/peer-client.mjs"]\n'
        entry = tomllib.loads(mcp_config.update_codex(source, SPEC))['mcp_servers']['desktop-bridge']
        self.assertEqual((entry['command'], entry['args']), ('cmd', ['/c', 'node.exe', CLIENT]))


class ClaudeConfig(unittest.TestCase):
    def test_keeps_wrapper_other_keys_and_missing_final_newline(self):
        source = json.dumps({'a': 1, 'mcpServers': {'desktop-bridge': {'type': 'stdio', 'command': 'cmd',
            'args': ['/c', 'node.exe', 'D:\\old\\peer-client.mjs'], 'env': {'DESKTOP_BRIDGE_CLIENT_REVISION': '0', 'X': 'y'}}}}, indent=2)
        updated = mcp_config.update_claude(source, SPEC)
        self.assertFalse(updated.endswith('\n'))
        entry = json.loads(updated)['mcpServers']['desktop-bridge']
        self.assertEqual(entry['command'], 'cmd')
        self.assertEqual(entry['args'], ['/c', 'node.exe', CLIENT])
        self.assertEqual(entry['env'], {'DESKTOP_BRIDGE_CLIENT_REVISION': REVISION, 'X': 'y'})

    def test_crlf_file_keeps_crlf_so_the_diff_stays_minimal(self):
        source = json.dumps({'a': 1, 'mcpServers': {'desktop-bridge': {'type': 'stdio', 'command': 'node.exe',
            'args': [CLIENT], 'env': {'DESKTOP_BRIDGE_CLIENT_REVISION': '0'}}}}, indent=2).replace('\n', '\r\n') + '\r\n'
        updated = mcp_config.update_claude(source, SPEC)
        self.assertNotIn('\n', updated.replace('\r\n', ''))
        changed = [line for line in mcp_config.unified_diff('c', source, updated, 0).splitlines()
                   if line[:1] in '+-' and not line.startswith(('+++', '---'))]
        self.assertEqual(len(changed), 2, changed)  # the revision line only; the launcher is kept


class Setup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.home, self.codex = base / 'home', base / 'home/.codex'
        self.codex.mkdir(parents=True)
        (self.codex / 'config.toml').write_text(CODEX_CURRENT, encoding='utf8', newline='')
        self.node = str(base / 'node.exe')
        Path(self.node).write_text('')
        self.addCleanup(self.temp.cleanup)
        self.runtime = base / 'runtime'

    def test_plan_reports_revisions_and_diffs_without_writing(self):
        before = (self.codex / 'config.toml').read_bytes()
        result = app_setup.plan(ROOT, self.home, self.codex, self.node, env={})
        self.assertEqual((self.codex / 'config.toml').read_bytes(), before)
        self.assertFalse((self.home / '.claude.json').exists())
        codex = result['apps']['codex']
        self.assertEqual((codex['mcp']['state'], codex['mcp']['configuredRevision'], codex['mcp']['currentRevision']),
                         ('outdated', '0000000000000000', REVISION))
        self.assertEqual(result['apps']['claude']['mcp']['state'], 'missing')
        self.assertEqual(result['apps']['antigravity']['mcp']['state'], 'not-installed')
        self.assertEqual(result['apps']['deepseek']['skill']['target'], 'agents')
        kinds = sorted((change['kind'], change.get('app') or change.get('target')) for change in result['changes'])
        self.assertEqual(kinds, [('mcp-config', 'claude'), ('mcp-config', 'codex'), ('skill', 'agents'), ('skill', 'claude')])
        codex_diff = next(c['diff'] for c in result['changes'] if c.get('app') == 'codex')
        self.assertIn('+DESKTOP_BRIDGE_CLIENT_REVISION = "' + REVISION + '"', codex_diff)
        self.assertEqual(result, app_setup.plan(ROOT, self.home, self.codex, self.node, env={}))

    def test_apply_requires_the_previewed_plan_and_converges(self):
        preview = app_setup.plan(ROOT, self.home, self.codex, self.node, env={})
        with self.assertRaisesRegex(RuntimeError, 'preview again'):
            app_setup.apply(ROOT, self.home, self.codex, self.node, '0' * 16, env={}, runtime=self.runtime)
        # A change after the preview invalidates it.
        (self.codex / 'config.toml').write_text(CODEX_CURRENT.replace('0000000000000000', '1111111111111111'), encoding='utf8', newline='')
        with self.assertRaisesRegex(RuntimeError, 'preview again'):
            app_setup.apply(ROOT, self.home, self.codex, self.node, preview['planId'], env={}, runtime=self.runtime)
        preview = app_setup.plan(ROOT, self.home, self.codex, self.node, env={})
        result = app_setup.apply(ROOT, self.home, self.codex, self.node, preview['planId'], env={}, runtime=self.runtime)
        self.assertEqual(result['status']['changes'], [])
        self.assertEqual({app: row['mcp']['state'] for app, row in result['status']['apps'].items()},
                         {'codex': 'current', 'claude': 'current', 'antigravity': 'not-installed', 'deepseek': 'not-applicable'})
        self.assertEqual({app: row['skill']['state'] for app, row in result['status']['apps'].items()},
                         {'codex': 'current', 'claude': 'current', 'deepseek': 'current', 'antigravity': 'missing'})
        data = tomllib.loads((self.codex / 'config.toml').read_text(encoding='utf8'))
        self.assertEqual(data['mcp_servers']['desktop-bridge']['tools']['bridge_ack'], {'approval_mode': 'approve'})
        self.assertTrue(Path(result['results']['mcp']['backupDirectory'], 'codex-config.toml').exists())
        self.assertEqual(bridge_skill.status(self.home / '.claude/skills/desktop-bridge', bridge_skill.skill_revision(ROOT))['state'], 'current')

    def test_antigravity_plugin_is_refreshed_with_its_hook_setting(self):
        _, antigravity = app_setup._installers(ROOT)
        antigravity.install(ROOT, self.home, self.node, identity_hook=True, runtime=self.runtime / 'antigravity')
        config = self.home / '.gemini/config/plugins/desktop-agent-bridge/mcp_config.json'
        data = json.loads(config.read_text(encoding='utf8'))
        data['mcpServers']['desktop-bridge']['env']['DESKTOP_BRIDGE_CLIENT_REVISION'] = 'old'
        config.write_text(json.dumps(data, indent=2) + '\n', encoding='utf8')
        preview = app_setup.plan(ROOT, self.home, self.codex, self.node, env={})
        row = preview['apps']['antigravity']['mcp']
        self.assertEqual((row['state'], row['configuredRevision'], row.get('pending')), ('outdated', 'old', True))
        change = next(c for c in preview['changes'] if c['kind'] == 'antigravity-plugin')
        self.assertTrue(change['identityHook'])
        self.assertIn('-        "DESKTOP_BRIDGE_CLIENT_REVISION": "old"', change['diff'])
        result = app_setup.apply(ROOT, self.home, self.codex, self.node, preview['planId'], env={}, runtime=self.runtime)
        self.assertEqual(result['status']['apps']['antigravity']['mcp']['state'], 'current')
        self.assertTrue((config.parent / 'hooks.json').exists())

    def test_cli_prints_utf8_json_and_reports_errors_on_one_line(self):
        import os
        import subprocess
        import sys
        env = {**os.environ, 'USERPROFILE': str(self.home), 'HOME': str(self.home), 'CODEX_HOME': str(self.codex),
               'PYTHONIOENCODING': 'cp936'}
        env.pop('CLAUDE_CONFIG_DIR', None)
        script = str(source_file(ROOT, 'setup-apps.py'))
        done = subprocess.run([sys.executable, script, 'plan', '--node', self.node], env=env, capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout.decode('utf8'))
        self.assertEqual(result['apps']['codex']['mcp']['configuredRevision'], '0000000000000000')
        self.assertTrue(any('cc-switch' in c['kind'] or c['kind'] == 'skill' for c in result['changes']))
        refused = subprocess.run([sys.executable, script, 'apply', '--plan-id', '0' * 16, '--node', self.node],
                                 env=env, capture_output=True, timeout=60)
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(refused.stderr.decode('utf8').strip().splitlines(), ['RuntimeError: Configuration changed since the preview; preview again before applying'])


if __name__ == '__main__':
    unittest.main()
