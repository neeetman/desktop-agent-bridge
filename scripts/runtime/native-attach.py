"""Attach the selected, coordinator-validated helper; no configuration touching."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import json
import sys
import threading
import frida
from attachment_runtime import compile_payload, request, AttachmentError


def attach(selected, kind, resume=False):
    request('validate', selected)
    source = compile_payload(selected, kind)
    device = frida.get_local_device()
    session = device.attach(selected['runningBuild']['pid'])
    installed, finished = threading.Event(), threading.Event()
    errors = []
    script = session.create_script(source)
    def receive(message, _):
        payload = message.get('payload', {})
        if payload.get('event') == 'installed':
            installed.set()
            finished.set()
        elif payload.get('event') in ['evaluation_failed', 'agent_error', 'skipped'] or message.get('type') == 'error':
            errors.append((payload.get('code') or 'ATTACHMENT_ERROR', payload.get('reason') or 'Native helper evaluation failed'))
            finished.set()
    script.on('message', receive)
    try:
        script.load()
        if resume:
            device.resume(selected['runningBuild']['pid'])
        finished.wait(45)
        if not installed.is_set():
            raise AttachmentError(*errors[-1]) if errors else AttachmentError('NATIVE_CALLBACK_PENDING', 'Native callback is pending')
    finally:
        if resume:
            try:
                device.resume(selected['runningBuild']['pid'])
            except Exception:
                pass
        session.detach()
    return {'installed': True, 'pid': selected['runningBuild']['pid'], 'globalConfigTouched': False}


if __name__ == '__main__':
    try:
        print(json.dumps(attach(json.load(sys.stdin), sys.argv[1])))
    except Exception as error:
        print(json.dumps({'installed': False, 'code': getattr(error, 'code', 'ATTACHMENT_ERROR'), 'error': str(error)}))
        sys.exit(1)
