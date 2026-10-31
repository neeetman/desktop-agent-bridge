import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from attachment_runtime import request, compile_payload, AttachmentError


class AttachmentRuntimeTest(unittest.TestCase):
    def test_coordinator_errors_keep_their_code(self):
        response = subprocess.CompletedProcess([], 1, json.dumps({'error': 'unknown build', 'code': 'BUILD_UNSUPPORTED'}), '')
        with patch('attachment_runtime.subprocess.run', return_value=response):
            with self.assertRaises(AttachmentError) as caught:
                request('resolve', {'app': 'codex'})
        self.assertEqual(caught.exception.code, 'BUILD_UNSUPPORTED')

    def test_compiled_payload_preserves_binding_paths_and_serializes_guard_failures(self):
        with tempfile.TemporaryDirectory(prefix='bridge payload ') as directory:
            adapter = Path(directory)
            (adapter / 'codex-main-execution.cjs').write_text('module.exports=function(root,config){return JSON.stringify({installed:true,root,binding:config.binding});};', encoding='utf8')
            (adapter / 'claude-attach-agent.js').write_text('__APPLICATION_CODE__', encoding='utf8')
            selected = {'app': 'codex', 'adapterRoot': directory, 'binding': {'installationId': 'fixture'}, 'profile': {'manifests': {'execution': {}}}}
            payload = json.loads(compile_payload(selected, 'execution'))
            response = subprocess.run(['node', '-e', 'process.stdout.write(eval(process.argv[1]));', payload], capture_output=True, text=True, check=True)
            value = json.loads(response.stdout)
            self.assertTrue(value['installed'])
            self.assertEqual(value['binding']['installationId'], 'fixture')
            (adapter / 'codex-main-execution.cjs').write_text('module.exports=function(){throw Object.assign(Error("old installation"),{code:"IDENTITY_MISMATCH"});};', encoding='utf8')
            payload = json.loads(compile_payload(selected, 'execution'))
            response = subprocess.run(['node', '-e', 'process.stdout.write(eval(process.argv[1]));', payload], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(response.stdout)['code'], 'IDENTITY_MISMATCH')


if __name__ == '__main__':
    unittest.main()
