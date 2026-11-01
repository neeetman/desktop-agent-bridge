"""Shared revision-aware attachment loop for the two desktop applications."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import ctypes
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from attachment_runtime import ROOT, selection, report, request
from native_attach_loader import attach_selected


def monitor(app, launch=None):
    directory = ROOT / 'runtime' / ('codex-mcp' if app == 'codex' else 'claude-attach')
    directory.mkdir(parents=True, exist_ok=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.CreateMutexW(None, False, 'Local\\' + ('CodexGuiBridgeMcpAutoAttach' if app == 'codex' else 'ClaudeGuiBridgeAutoAttach'))
    if ctypes.get_last_error() == 183:
        raise RuntimeError('Native monitor already running for this app')
    def write(file, value):
        temporary = directory / (file + '.tmp')
        temporary.write_text(json.dumps(value), encoding='utf8')
        os.replace(temporary, directory / file)
    write('connection.json', {'pid': os.getpid()})
    status_file = 'monitor-status.json' if app == 'codex' else 'status.json'
    previous_key, retry_at, failures = None, 0, 0
    suspended, attempted_launch = set(), False
    worker, outcome = None, {}
    def install(selected):
        pid = selected['runningBuild']['pid']
        try:
            kind = 'mcp' if app == 'codex' else 'claude'
            pid = selected['runningBuild']['pid']
            attach_selected(selected, kind, resume=pid in suspended)
            suspended.discard(pid)
            outcome.update(ok=True, key=json.dumps(selected['binding'], sort_keys=True))
        except Exception as error:
            outcome.update(ok=False, error=str(error), code=getattr(error, 'code', 'ATTACHMENT_ERROR'), key=json.dumps(selected['binding'], sort_keys=True))
        finally:
            if pid in suspended:
                import frida
                try:
                    frida.get_local_device().resume(pid)
                except Exception:
                    pass
                suspended.discard(pid)
    try:
        while True:
            write('heartbeat.json', {'pid': os.getpid(), 'time': int(time.time() * 1000)})
            state = {'monitorPid': os.getpid(), 'time': time.time()}
            try:
                selected = selection(app, 'mcp' if app == 'codex' else 'read')
                key = json.dumps(selected['binding'], sort_keys=True)
                if key != previous_key:
                    previous_key, retry_at, failures = key, 0, 0
                    outcome.clear()
                if worker and worker.is_alive():
                    state.update(state='attaching')
                elif outcome.get('key') == previous_key and outcome.get('code') in ['IDENTITY_MISMATCH', 'CONTRACT_MISMATCH', 'REFRESH_DEFERRED_BUSY']:
                    state.update(state='incompatible', code=outcome['code'], error=outcome.get('error'))
                    if time.monotonic() >= retry_at:
                        value = subprocess.run(['node', str(source_file(ROOT, 'compat-helper-status.mjs')), app], input=json.dumps(selected), capture_output=True, text=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                        observed = json.loads(value.stdout)
                        if observed.get('ready') or observed.get('code') in ['ENOENT', 'ECONNREFUSED']:
                            outcome.clear()
                        retry_at = time.monotonic() + 10
                elif time.monotonic() < retry_at:
                    state.update(state='waiting_for_native_callback', error=outcome.get('error'))
                else:
                    value = subprocess.run(['node', str(source_file(ROOT, 'compat-helper-status.mjs')), app], input=json.dumps(selected), capture_output=True, text=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                    result = json.loads(value.stdout)
                    if result.get('ready'):
                        failures = 0
                        state.update(state='installed', binding=selected['binding'])
                        report(selected, 'attached', helperReady=True, kind='mcp' if app == 'codex' else 'claude')
                    elif result.get('code') == 'IDENTITY_MISMATCH':
                        outcome.update(ok=False, key=previous_key, code='IDENTITY_MISMATCH', error='Existing helper belongs to another installation/epoch; use idle maintenance')
                        state.update(state='incompatible', code='IDENTITY_MISMATCH', error=outcome['error'])
                    else:
                        failures += 1
                        retry_at = time.monotonic() + min(60, 2 ** min(failures, 6))
                        outcome.clear()
                        worker = threading.Thread(target=install, args=(selected,), daemon=True)
                        worker.start()
                        state.update(state='attaching')
            except Exception as error:
                state.update(state='incompatible', code=getattr(error, 'code', 'COMPATIBILITY_ERROR'), error=str(error)[:500])
                if getattr(error, 'code', '') == 'DESKTOP_NOT_RUNNING' and launch and not attempted_launch:
                    attempted_launch = True
                    try:
                        request('launch-plan', {'app': app, 'executable': str(launch)})
                        import frida
                        suspended.add(frida.get_local_device().spawn([str(launch)], stdio='pipe'))
                    except Exception as launch_error:
                        state.update(state='incompatible', error=str(launch_error))
                elif suspended and not (worker and worker.is_alive()):
                    import frida
                    for pid in list(suspended):
                        try:
                            frida.get_local_device().resume(pid)
                        except Exception:
                            pass
                        suspended.discard(pid)
            if app == 'claude':
                write(status_file, {'processes': [state], **state})
            else:
                write(status_file, state)
            time.sleep(2)
    finally:
        if suspended:
            import frida
            for pid in suspended:
                try:
                    frida.get_local_device().resume(pid)
                except Exception:
                    pass
        kernel.CloseHandle(handle)
