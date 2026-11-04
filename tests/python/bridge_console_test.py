import io
import json
import unittest
from unittest.mock import patch
from bridge_console import upstream_profile


class ConsoleUpdateTests(unittest.TestCase):
    def test_fetch_pins_adapter_bytes_and_requires_exact_build(self):
        revision = 'a' * 40
        profile = {'id':'example','app':'codex','hashes':{'exe':'one'},'adapterFiles':['adapter.cjs']}
        replies = {'compat/catalog.json':{'profiles':['compat/codex/profile.json']},
                   'compat/codex/profile.json':profile, 'src/layout.json':{'files':{'adapter.cjs':'src/adapter.cjs'}}}
        def fetch(request, timeout):
            url = request.full_url
            if url.endswith('/commits/main'):
                return io.BytesIO(json.dumps({'sha':revision}).encode())
            self.assertIn('/'+revision+'/', url)
            relative = url.split('/'+revision+'/')[1]
            return io.BytesIO(b'code' if relative == 'src/adapter.cjs' else json.dumps(replies[relative]).encode())
        with patch('urllib.request.urlopen',side_effect=fetch):
            self.assertEqual(upstream_profile('codex',{'exe':'one'}), (revision,profile,{'adapter.cjs':b'code'}))
            with self.assertRaisesRegex(ValueError,'No validated'):
                upstream_profile('codex',{'exe':'two'})
