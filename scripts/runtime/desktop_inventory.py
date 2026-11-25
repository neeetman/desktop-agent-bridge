"""Read desktop identity through Win32, without the WMI process provider."""
import ctypes
from ctypes import wintypes as w
import datetime
import json
import os
from pathlib import Path
import re
import sys


def cim_time(ticks):
    # CIM's DMTF timestamp has microsecond precision. Preserve the existing
    # generation key exactly when switching providers on a live installation.
    epoch = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
    value = epoch + datetime.timedelta(microseconds=ticks // 10)
    return value.strftime('%Y-%m-%dT%H:%M:%S.') + f'{value.microsecond:06d}0Z'


def _has_same_app_ancestor(row, by_pid):
    name = row['Name'].lower()
    seen = {row['ProcessId']}
    pid = row.get('ParentProcessId')
    while pid and pid not in seen:
        seen.add(pid)
        parent = by_pid.get(pid)
        if parent is None:
            return False
        if parent['Name'].lower() == name:
            return True
        pid = parent.get('ParentProcessId')
    return False


def desktop_rows(rows):
    by_pid = {row['ProcessId']: row for row in rows}
    result = []
    for row in rows:
        app = 'claude' if row['Name'].lower() == 'claude.exe' else 'codex'
        if row.get('accessDenied'):
            # An inaccessible helper under a known desktop is harmless; a root
            # inaccessible candidate must still surface so it is not mistaken
            # for an absent desktop.
            if not _has_same_app_ancestor(row, by_pid):
                result.append({'app': app, 'pid': row['ProcessId'],
                               'createdAt': None, 'executable': None, 'accessDenied': True})
            continue
        exe = row.get('ExecutablePath')
        if (exe and (Path(exe).parent / 'resources/app.asar').is_file()
                # Electron helpers (renderer, GPU, crash reporter) carry --type=. A
                # helper whose main process already exited has no same-image parent
                # and would otherwise look like a second desktop.
                and ' --type=' not in (row.get('CommandLine') or '')
                and not any(parent['ProcessId'] == row['ParentProcessId']
                            and (parent.get('ExecutablePath') or '').lower() == exe.lower()
                            for parent in rows)):
            result.append({'app': app, 'pid': row['ProcessId'], 'createdAt': row['Created'],
                           'executable': str(Path(exe).with_name(
                               'Claude.exe' if row['Name'].lower() == 'claude.exe' else 'ChatGPT.exe'))})
    return result


def app_server_host(main_pid, rows=None):
    """PID of the Codex "App server host" utility process under one desktop main process.

    Codex 26.1117+ forks app-server-host.js as an Electron utility process; that
    process owns the app-server connection and the conversation manager, and is
    the parent of `codex.exe app-server`. Exactly one must exist."""
    rows = process_rows(('chatgpt.exe', 'codex.exe')) if rows is None else rows
    main = next((row for row in rows if row['ProcessId'] == main_pid), None)
    if main is None:
        raise RuntimeError('Codex desktop process is not running')
    if main.get('accessDenied'):
        raise RuntimeError('Codex desktop process is inaccessible')
    servers = {row['ParentProcessId'] for row in rows
               if row['Name'].lower() == 'codex.exe' and ' app-server' in (row.get('CommandLine') or '')}
    hosts = [row['ProcessId'] for row in rows
             if row['ParentProcessId'] == main_pid
             and (row.get('ExecutablePath') or '').lower() == main['ExecutablePath'].lower()
             and ' --type=utility' in (row.get('CommandLine') or '')
             and 'node.mojom.NodeService' in (row.get('CommandLine') or '')
             and row['ProcessId'] in servers]
    if len(hosts) != 1:
        raise RuntimeError(f'Expected one Codex app server host process, found {len(hosts)}')
    return hosts[0]


def attach_pid(main_pid, host=None, rows=None):
    """The process a helper is evaluated in: the desktop main process, or its app server host."""
    if host is None:
        return main_pid
    if host != 'app-server-host':
        raise RuntimeError('Unsupported helper host: ' + str(host))
    return app_server_host(main_pid, rows)


def visible_window(pid):
    """Whether the process owns a visible, titled top-level window.

    Codex answers its desktop chat tools only while its window exists; running
    from the tray alone, tool calls are accepted but never complete."""
    user = ctypes.WinDLL('user32', use_last_error=True)
    found = []
    proc = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    user.EnumWindows.argtypes = [proc, w.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    user.IsWindowVisible.argtypes = [w.HWND]
    user.GetWindowTextLengthW.argtypes = [w.HWND]
    user.GetWindow.argtypes = [w.HWND, w.UINT]
    user.GetWindow.restype = w.HWND

    def check(hwnd, _):
        owner = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        # A real top-level window: visible, titled, and not owned by another window.
        if (owner.value == pid and user.IsWindowVisible(hwnd)
                and user.GetWindowTextLengthW(hwnd) > 0 and not user.GetWindow(hwnd, 4)):
            found.append(hwnd)
            return False
        return True
    user.EnumWindows(proc(check), 0)
    return bool(found)


def command_line(handle):
    """Command line through ProcessCommandLineInformation (needs only limited query access).

    Returns None when it cannot be read; callers then fall back to parent checks."""
    ntdll = ctypes.WinDLL('ntdll')
    ntdll.NtQueryInformationProcess.argtypes = [w.HANDLE, w.ULONG, ctypes.c_void_p, w.ULONG, ctypes.POINTER(w.ULONG)]
    ntdll.NtQueryInformationProcess.restype = w.LONG
    size = w.ULONG(0)
    ntdll.NtQueryInformationProcess(handle, 60, None, 0, ctypes.byref(size))
    if not size.value or size.value > 1 << 20:
        return None
    buffer = ctypes.create_string_buffer(size.value)
    if ntdll.NtQueryInformationProcess(handle, 60, buffer, size, ctypes.byref(size)) != 0:
        return None
    class UnicodeString(ctypes.Structure):
        _fields_ = [('Length', w.USHORT), ('MaximumLength', w.USHORT), ('Buffer', ctypes.c_void_p)]
    value = UnicodeString.from_buffer(buffer)
    if not value.Buffer or not value.Length:
        return None
    return ctypes.wstring_at(value.Buffer, value.Length // 2)


_ERROR_ACCESS_DENIED = 5
_ERROR_INVALID_PARAMETER = 87
_STILL_ACTIVE = 259


def _access_denied_row(pid, parent_pid, exe_name):
    return {'ProcessId': pid, 'ParentProcessId': parent_pid, 'Name': exe_name,
            'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True}


def _process_exited(kernel, handle):
    code = w.DWORD()
    return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value != _STILL_ACTIVE


def _inspect_candidate(pid, parent_pid, exe_name, session_id, kernel,
                       get_last_error=ctypes.get_last_error, read_command_line=command_line):
    candidate_session = w.DWORD()
    if not kernel.ProcessIdToSessionId(pid, ctypes.byref(candidate_session)):
        err = get_last_error()
        if err == _ERROR_INVALID_PARAMETER:
            return None
        if err == _ERROR_ACCESS_DENIED:
            return _access_denied_row(pid, parent_pid, exe_name)
        raise ctypes.WinError(err)
    if candidate_session.value != session_id:
        return None
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        err = get_last_error()
        if err == _ERROR_INVALID_PARAMETER:
            return None
        if err == _ERROR_ACCESS_DENIED:
            # Inaccessible candidates must not be mistaken for an absent desktop.
            return _access_denied_row(pid, parent_pid, exe_name)
        raise ctypes.WinError(err)
    try:
        name = ctypes.create_unicode_buffer(32768)
        size = w.DWORD(len(name))
        if not kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
            err = get_last_error()
            if err == _ERROR_INVALID_PARAMETER or _process_exited(kernel, handle):
                return None
            if err == _ERROR_ACCESS_DENIED:
                return _access_denied_row(pid, parent_pid, exe_name)
            raise ctypes.WinError(err)
        times = [w.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            err = get_last_error()
            if err == _ERROR_INVALID_PARAMETER or _process_exited(kernel, handle):
                return None
            if err == _ERROR_ACCESS_DENIED:
                return _access_denied_row(pid, parent_pid, exe_name)
            raise ctypes.WinError(err)
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return {'ProcessId': pid, 'ParentProcessId': parent_pid,
                'Name': exe_name, 'ExecutablePath': name.value,
                'Created': cim_time(created), 'CommandLine': read_command_line(handle)}
    finally:
        kernel.CloseHandle(handle)


def process_rows(names=('chatgpt.exe', 'claude.exe'), pids=None):
    if os.name != 'nt':
        raise RuntimeError('Win32 process inventory requires Windows')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    class Entry(ctypes.Structure):
        _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD),
                    ('th32ProcessID', w.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', w.DWORD), ('cntThreads', w.DWORD),
                    ('th32ParentProcessID', w.DWORD), ('pcPriClassBase', w.LONG),
                    ('dwFlags', w.DWORD), ('szExeFile', w.WCHAR * 260)]
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    for name in ['Process32FirstW', 'Process32NextW']:
        getattr(kernel, name).argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
        getattr(kernel, name).restype = w.BOOL
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.ProcessIdToSessionId.argtypes = [w.DWORD, ctypes.POINTER(w.DWORD)]
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
    kernel.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    kernel.GetExitCodeProcess.restype = w.BOOL
    session = w.DWORD()
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        raise ctypes.WinError(ctypes.get_last_error())
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows = []
    try:
        entry = Entry(); entry.dwSize = ctypes.sizeof(entry)
        found = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while found:
            if entry.szExeFile.lower() in names and (pids is None or entry.th32ProcessID in pids):
                row = _inspect_candidate(entry.th32ProcessID, entry.th32ParentProcessID,
                                         entry.szExeFile, session.value, kernel)
                if row is not None:
                    rows.append(row)
            found = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(snapshot)
    return rows


def installed_packages():
    import winreg
    location = r'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
    selected = {}
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, location)
    except FileNotFoundError:
        return []  # Unpackaged installations need no MSIX registration.
    with key:
        for index in range(winreg.QueryInfoKey(key)[0]):
            name = winreg.EnumKey(key, index)
            match = re.fullmatch(r'(OpenAI\.Codex|Claude)_(\d+(?:\.\d+){3})_x64__[^_]+', name)
            if not match:
                continue
            with winreg.OpenKey(key, name) as package:
                directory = winreg.QueryValueEx(package, 'PackageRootFolder')[0]
            if not Path(directory).is_dir():
                continue
            app = 'codex' if match[1] == 'OpenAI.Codex' else 'claude'
            version = tuple(map(int, match[2].split('.')))
            if app not in selected or version > selected[app][0]:
                selected[app] = (version, {'app': app, 'version': match[2], 'directory': directory})
    return [item[1] for item in selected.values()]


if __name__ == '__main__':
    if sys.argv[1:2] == ['--visible-window']:
        print(json.dumps({'visible': visible_window(int(sys.argv[2]))}))
    elif sys.argv[1:2] == ['--app-server-host']:
        print(json.dumps({'pid': app_server_host(int(sys.argv[2]))}))
    elif sys.argv[1:2] == ['--workers']:
        print(json.dumps(process_rows(('node.exe',), set(map(int, sys.argv[2:])))))
    else:
        print(json.dumps({'processes': desktop_rows(process_rows()), 'installed': installed_packages()}))
