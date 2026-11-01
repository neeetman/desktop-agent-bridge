import unittest
from deepseek_profile import replace_managed_block, plugin_sources
from bridge_paths import ROOT

class ProfilePreservation(unittest.TestCase):
    def test_host_release_uses_self_contained_shared_imports(self):
        sources=plugin_sources(ROOT)
        self.assertEqual(set(sources), {'deepseek-plugin.mjs','peer-catalog.mjs','peer-call.mjs'})
        plugin=sources['deepseek-plugin.mjs'].decode('utf8')
        self.assertIn("from './peer-catalog.mjs'",plugin)
        self.assertIn("from './peer-call.mjs'",plugin)
        self.assertNotIn('../../mcp/',plugin)
    def test_original_flow_row(self):
        before='- id: other\n  config: 1\n# desktop-session-bridge managed entry\n- insert:\n    - {"id": "desktop-session-bridge", "config": {"port":43132}}\n'
        self.assertEqual(replace_managed_block(before,'# replacement\n'),'- id: other\n  config: 1\n# replacement\n')
    def test_native_editor_wrapping_preserves_following_model_and_comments(self):
        owned='# desktop-session-bridge managed entry\n- insert:\n    - {\n        "id": "desktop-session-bridge",\n        "config": { "port": 43132 }\n      }\n'
        following='# model selection saved by Harness\n- id: agent-default-model\n  config:\n    model: custom-model\n'
        result=replace_managed_block('- id: other\n'+owned+following,'# replacement\n')
        self.assertEqual(result,'- id: other\n'+following+'# replacement\n')
    def test_additional_user_row_is_never_removed(self):
        source='# desktop-session-bridge managed entry\n- insert:\n    - {"id":"desktop-session-bridge"}\n    - {"id":"user-plugin"}\n'
        with self.assertRaisesRegex(RuntimeError,'additional'):
            replace_managed_block(source,'# replacement\n')
    def test_versioned_owned_entry_is_replaced(self):
        source='# desktop-session-bridge managed entry\n- insert:\n    - {"id":"desktop-session-bridge-0123456789abcdef"}\n- id: other\n'
        self.assertEqual(replace_managed_block(source,'# replacement\n'),'- id: other\n# replacement\n')

if __name__=='__main__': unittest.main()
