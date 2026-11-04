"""One bounded attachment to a fingerprinted desktop, without replacing its helper."""
import hashlib
import json
from pathlib import Path
import sys
import threading
import subprocess
import frida
from desktop_inventory import desktop_rows, process_rows

def attach(data):
    build = data['build']
    app = build['app']
    exe = Path(build['executable'])
    files = {'executableSha256': exe, 'asarSha256': exe.parent / 'resources/app.asar'}
    if app == 'codex':
        files['chromeSha256'] = exe.parent / 'chrome.dll'
    for key, file in files.items():
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != build['hashes'][key]:
                raise ValueError('Desktop fingerprint changed')
    rows = [row for row in desktop_rows(process_rows()) if row['app'] == app]
    if len(rows) != 1 or any(rows[0][k] != build[k] for k in ('pid', 'createdAt', 'executable')):
        raise ValueError('Desktop process generation changed')
    source = (Path(data['adapterRoot']) / 'claude-attach-agent.js').read_text(encoding='utf8')
    if app == 'codex':
        source = source.replace("Process.getModuleByName('Claude.exe')", "Process.getModuleByName('chrome.dll')")
    event = threading.Event()
    session = frida.attach(build['pid'])
    try:
        script = session.create_script(source.replace('__APPLICATION_CODE__', json.dumps(data['code'])))
        errors = []
        def receive(msg, _):
            payload = msg.get('payload', {})
            if payload.get('event') == 'installed':
                event.set()
            elif payload.get('event') in ('evaluation_failed','agent_error') or msg.get('type') == 'error':
                errors.append(payload.get('error') or msg.get('description') or payload.get('event'))
        script.on('message', receive)
        script.load()
        if not event.wait(4) and app == 'claude' and desktop_rows(process_rows()).count(rows[0]) == 1:
            # A second-instance notification wakes Node-API in an idle desktop.
            # This is only used during a user-triggered live validation.
            subprocess.Popen([exe], creationflags=subprocess.CREATE_NO_WINDOW)
        if not event.wait(40):
            raise RuntimeError(app + ' native callback timed out: ' + str(errors[-1:] or 'no Node-API callback'))
    finally:
        session.detach()

if __name__ == '__main__':
    attach(json.load(sys.stdin))
