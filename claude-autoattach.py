"""Version-bound, local Claude main-process attachment; no DevTools/CDP port."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time

import frida

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'runtime' / 'claude-attach'
MANIFEST = ROOT / 'claude-attach-compatibility.json'


class ProcessEntry(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                ('parent', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                ('name', wintypes.WCHAR * 260)]


kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]


def processes():
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows = {}
    try:
        entry = ProcessEntry(size=ctypes.sizeof(ProcessEntry))
        ok = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            rows[entry.pid] = (entry.name.lower(), entry.parent)
            ok = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    result = []
    for pid, (name, parent) in rows.items():
        if name != 'claude.exe' or rows.get(parent, ('', 0))[0] == 'claude.exe':
            continue
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            continue
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(buffer))
            if kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
                executable = Path(buffer.value)
                # Exclude standalone CLI workers and unrelated executables with this basename.
                if (executable.parent / 'resources' / 'app.asar').is_file():
                    result.append((pid, executable))
        finally:
            kernel.CloseHandle(handle)
    return result


def atomic_json(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, file)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--launch', type=Path, help='Launch this verified executable once if Claude is closed')
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    # Named mutex prevents multiple monitors racing to inject the same startup.
    kernel.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel.CreateMutexW(None, False, 'Local\\ClaudeGuiBridgeAutoAttach')
    if ctypes.get_last_error() == 183:
        raise SystemExit('Claude auto-attach monitor is already running')
    atomic_json(STATE / 'connection.json', {'pid': os.getpid(), 'script': str(Path(__file__).resolve())})
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    revision = hashlib.sha256((ROOT/'claude-main-attach.cjs').read_bytes() + (ROOT/'claude-renderer.mjs').read_bytes()).hexdigest()[:16]
    config = {
        'connectionFile': str(ROOT / 'runtime/claude-relay/connection.json'),
        'bootstrapFile': str(ROOT / 'runtime/claude-relay/bootstrap-files.js'),
        'pipe': r'\\.\pipe\claude-gui-bridge-control',
        'compatibilityFile': str(MANIFEST),
        'revision': revision,
        'transport': manifest.get('transport'),
    }
    built = subprocess.run(['node', '-e', 'const f=require(process.argv[1]);process.stdout.write("("+f.toString()+")("+process.argv[2]+")");', str(ROOT/'claude-main-attach.cjs'), json.dumps(config)], capture_output=True, text=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    source = (ROOT/'claude-attach-agent.js').read_text(encoding='utf-8').replace('__APPLICATION_CODE__', json.dumps(built.stdout))
    device = frida.get_local_device()
    checked = {}
    active = {}
    statuses = {}
    lock = threading.Lock()

    def persist():
        with lock:
            atomic_json(STATE/'status.json', {'monitorPid': os.getpid(), 'updatedAt': time.time(), 'processes': list(statuses.values())})

    def report(pid, state, **fields):
        with lock:
            statuses[pid] = {'pid': pid, 'state': state, **fields}
        persist()
        print(json.dumps({'pid': pid, 'state': state, **fields}), flush=True)

    def verify(executable):
        stat = executable.stat()
        asar = executable.parent/'resources'/'app.asar'
        asar_stat = asar.stat()
        cache_key = (str(executable).lower(), stat.st_size, stat.st_mtime_ns, asar_stat.st_size, asar_stat.st_mtime_ns)
        if cache_key not in checked:
            with executable.open('rb') as executable_stream, asar.open('rb') as asar_stream:
                hashes = {'executableSha256': hashlib.file_digest(executable_stream, 'sha256').hexdigest(),
                          'asarSha256': hashlib.file_digest(asar_stream, 'sha256').hexdigest()}
            if any(hashes[key] != manifest[key] for key in hashes):
                raise RuntimeError('Claude version/hash changed; attachment disabled until compatibility is validated')
            checked[cache_key] = True

    def attach(pid, executable, resume=False):
        session = None
        installed = threading.Event()
        detached = threading.Event()
        try:
            report(pid, 'attaching')
            session = device.attach(pid)
            session.on('detached', lambda *_: detached.set())
            script = session.create_script(source)

            def message(message, _data):
                payload = message.get('payload', {})
                if payload.get('event') == 'installed':
                    report(pid, 'installed', installedAt=time.time(), reused=payload.get('reused', False))
                    installed.set()
                elif payload.get('event') in ('agent_error', 'evaluation_failed') or message.get('type') == 'error':
                    report(pid, 'attachment_error', event=payload.get('event', 'frida_error'))

            script.on('message', message)
            script.load()
            if resume:
                device.resume(pid)
            deadline = time.monotonic() + 30
            while not installed.wait(.1) and not detached.is_set() and time.monotonic() < deadline:
                pass
            if not installed.is_set() and not detached.is_set():
                report(pid, 'waiting_for_native_callback', detail='Monitor attached after native initialization; a managed restart guarantees startup attachment')
            # Main-process lifecycle hooks are ordinary application JS and survive Frida detach.
        except Exception as error:
            report(pid, 'attachment_error', error=str(error)[:250])
            if resume:
                try: device.resume(pid)
                except Exception: pass
        finally:
            if session:
                try: session.detach()
                except Exception: pass

    def known_installation(pid):
        try:
            response = subprocess.run(['node', str(ROOT/'claude-lifecycle.mjs'), 'status'], capture_output=True, text=True, timeout=6, creationflags=subprocess.CREATE_NO_WINDOW)
            status = json.loads(response.stdout) if response.returncode == 0 else {}
            if status.get('pid') == pid and status.get('revision') == revision:
                report(pid, 'installed', reused=True, observedAt=time.time())
                return True
        except (subprocess.TimeoutExpired, ValueError):
            pass
        return False

    try:
        initial = processes()
        if not initial and args.launch:
            verify(args.launch)
            pid = device.spawn([str(args.launch)], stdio='pipe')
            worker = threading.Thread(target=attach, args=(pid, args.launch, True), daemon=True)
            active[pid] = worker
            worker.start()
        while True:
            if not hasattr(main, '_heartbeat_at') or time.monotonic()-main._heartbeat_at>5:
                atomic_json(STATE/'heartbeat.json',{'pid':os.getpid(),'time':int(time.time()*1000)})
                main._heartbeat_at=time.monotonic()
            observed = processes()
            pids = {pid for pid, _ in observed}
            for pid in list(active):
                if pid not in pids and not active[pid].is_alive():
                    active.pop(pid)
                    with lock: statuses.pop(pid, None)
                    persist()
            for pid, executable in observed:
                if pid in active:
                    continue
                try:
                    verify(executable)
                    # Only the monitor's initial snapshot may already have installed hooks.
                    reused = any(pid == initial_pid for initial_pid, _ in initial) and known_installation(pid)
                    worker = threading.Thread(target=attach, args=(pid, executable), daemon=True)
                    active[pid] = worker
                    if not reused:
                        worker.start()
                except Exception as error:
                    report(pid, 'incompatible', error=str(error)[:250])
                    active[pid] = threading.Thread()
            time.sleep(.1)
    finally:
        kernel.CloseHandle(mutex)


if __name__ == '__main__':
    main()
