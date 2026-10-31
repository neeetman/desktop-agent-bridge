"""Attach the MCP config watcher to the running Codex desktop, never a new CLI server."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import ctypes

import frida

ROOT = Path(__file__).resolve().parent
DIRECTORY = ROOT/'runtime/codex-mcp'
DIRECTORY.mkdir(parents=True, exist_ok=True)


def write_status(status):
    temporary = DIRECTORY/'monitor-status.tmp'
    temporary.write_text(json.dumps({'monitorPid': os.getpid(), 'time': time.time(), **status}, indent=2), encoding='utf-8')
    os.replace(temporary, DIRECTORY/'monitor-status.json')


def main():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.restype = ctypes.c_void_p
    mutex = kernel.CreateMutexW(None, False, 'Local\\CodexGuiBridgeMcpAutoAttach')
    if ctypes.get_last_error() == 183:
        raise SystemExit('Codex MCP monitor already running')
    (DIRECTORY/'connection.json').write_text(json.dumps({'pid': os.getpid(), 'script': str(Path(__file__).resolve())}), encoding='utf-8')
    manifest = json.loads((ROOT/'codex-mcp-compatibility.json').read_text(encoding='utf-8'))
    device = frida.get_local_device()
    checked = set()
    handled = set()
    compiled = subprocess.run(['node','-e','const f=require(process.argv[1]);process.stdout.write("("+f.toString()+")("+JSON.stringify(process.argv[2])+")");',str(ROOT/'codex-main-mcp.cjs'),str(ROOT)],capture_output=True,text=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW).stdout
    source = (ROOT/'claude-attach-agent.js').read_text(encoding='utf-8').replace("Process.getModuleByName('Claude.exe')", "Process.getModuleByName('chrome.dll')").replace('__APPLICATION_CODE__', json.dumps(compiled))

    def attach(pid):
        session = None
        try:
            write_status({'state':'attaching','targetPid':pid})
            session = device.attach(pid)
            script = session.create_script(source)
            ready = threading.Event()

            def message(value, _data):
                event = value.get('payload',{}).get('event')
                if event == 'installed':
                    write_status({'state':'installed','targetPid':pid})
                    ready.set()
                elif event in ('agent_error','evaluation_failed'):
                    write_status({'state':'attachment_error','targetPid':pid,'event':event})

            script.on('message',message)
            script.load()
            # Normal native callbacks suffice; never touch user config just to attach.
            if not ready.wait(45):
                write_status({'state':'awaiting_native_callback','targetPid':pid})
        except Exception as error:
            write_status({'state':'attachment_error','targetPid':pid,'error':str(error)[:250]})
        finally:
            if session:
                try:session.detach()
                except Exception:pass

    write_status({'state':'waiting_for_desktop'})
    while True:
        heartbeat=DIRECTORY/'heartbeat.json'
        temporary=DIRECTORY/'heartbeat.tmp'
        temporary.write_text(json.dumps({'pid':os.getpid(),'time':int(time.time()*1000)}),encoding='utf-8')
        os.replace(temporary,heartbeat)
        processes = device.enumerate_processes(scope='metadata')
        by_pid = {row.pid:row for row in processes}
        candidates = []
        for row in processes:
            executable = Path(row.parameters.get('path',''))
            if row.name.lower() not in ('chatgpt.exe','codex.exe') or not (executable.parent/'resources/app.asar').is_file():
                continue
            parent = by_pid.get(row.parameters.get('ppid'))
            if parent and parent.parameters.get('path','').lower() == str(executable).lower():
                continue
            candidates.append((row.pid,executable))
        current = {pid for pid,_ in candidates}
        handled.intersection_update(current)
        for pid,executable in candidates:
            if pid in handled:
                continue
            key = str(executable).lower()
            try:
                if key not in checked:
                    for file, expected in [(executable,manifest['executableSha256']),(executable.parent/'chrome.dll',manifest['chromeSha256']),(executable.parent/'resources/app.asar',manifest['asarSha256'])]:
                        with file.open('rb') as stream:
                            actual=hashlib.file_digest(stream,'sha256').hexdigest()
                        if actual != expected:
                            raise RuntimeError('Codex desktop build changed; native MCP attachment requires revalidation')
                    checked.add(key)
                # Reuse a live installation if only this external monitor was restarted.
                result = subprocess.run(['node',str(ROOT/'codex-mcp-control.mjs'),'status'],capture_output=True,text=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW)
                installed = json.loads(result.stdout) if result.returncode == 0 else {}
                handled.add(pid)
                if installed.get('pid') == pid and installed.get('helperRevision') == manifest.get('helperRevision'):
                    write_status({'state':'installed','targetPid':pid,'reused':True})
                else:
                    threading.Thread(target=attach,args=(pid,),daemon=True).start()
            except Exception as error:
                handled.add(pid)
                write_status({'state':'incompatible','targetPid':pid,'error':str(error)[:250]})
        time.sleep(1)


if __name__ == '__main__':
    main()
