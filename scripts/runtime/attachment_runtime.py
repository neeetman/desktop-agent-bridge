"""Shared coordinator client for Python native monitors. No token is returned."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import json
from pathlib import Path
import subprocess



class AttachmentError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def request(action, data):
    result = subprocess.run(['node', str(source_file(ROOT, 'compat-service.mjs')), action],
                            input=json.dumps(data), capture_output=True, text=True,
                            timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    value = json.loads(result.stdout)
    if value.get('error'):
        raise AttachmentError(value['code'], value['error'])
    return value


def selection(app, capability, pid=None):
    return request('resolve', {'app': app, 'capability': capability, 'pid': pid})


def compile_payload(selected, kind):
    adapter = Path(selected['adapterRoot'])
    app = selected['app']
    manifest = selected['profile']['manifests'][kind]
    config = {'binding': selected['binding'], 'manifest': manifest, 'adapterRoot': str(adapter)}
    file = adapter / {'execution': 'codex-main-execution.cjs', 'mcp': 'codex-main-mcp.cjs',
                       'claude': 'claude-main-attach.cjs'}[kind]
    if app == 'claude':
        config.update({'connectionFile': str(ROOT / 'runtime/claude-relay/connection.json'),
                       'bootstrapFile': str(ROOT / 'runtime/claude-relay/bootstrap-files.js'),
                       'pipe': r'\\.\pipe\claude-gui-bridge-control',
                       'transport': manifest['transport'], 'revision': selected['profile']['adapterDigest']})
        arguments = json.dumps(config)
    else:
        arguments = json.dumps(str(ROOT)) + ',' + json.dumps(config)
    built = subprocess.run(['node', '-e', 'const f=require(process.argv[1]);process.stdout.write("(()=>{try{return ("+f.toString()+")("+process.argv[2]+");}catch(e){return JSON.stringify({installed:false,code:e.code,reason:e.message});}})()");',
                            str(file), arguments], capture_output=True, text=True, check=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    source = (adapter / 'claude-attach-agent.js').read_text(encoding='utf8')
    if app == 'codex':
        source = source.replace("Process.getModuleByName('Claude.exe')", "Process.getModuleByName('chrome.dll')")
    return source.replace('__APPLICATION_CODE__', json.dumps(built.stdout))


def report(selected, phase, **details):
    return request('report', {'app': selected['app'], 'binding': selected['binding'],
                              'phase': phase, 'details': details})
