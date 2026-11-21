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


def desktop_rows(rows):
    return [{'app': 'claude' if row['Name'].lower() == 'claude.exe' else 'codex',
             'pid': row['ProcessId'], 'createdAt': row['Created'],
             'executable': str(Path(row['ExecutablePath']).with_name(
                 'Claude.exe' if row['Name'].lower() == 'claude.exe' else 'ChatGPT.exe'))}
            for row in rows
            if (Path(row['ExecutablePath']).parent / 'resources/app.asar').is_file()
            # Electron helpers (renderer, GPU, crash reporter) carry --type=. A
            # helper whose main process already exited has no same-image parent
            # and would otherwise look like a second desktop.
            and ' --type=' not in (row.get('CommandLine') or '')
            and not any(parent['ProcessId'] == row['ParentProcessId']
                        and parent['ExecutablePath'].lower() == row['ExecutablePath'].lower()
                        for parent in rows)]


def app_server_host(main_pid, rows=None):
    """PID of the Codex "App server host" utility process under one desktop main process.

    Codex 26.1117+ forks app-server-host.js as an Electron utility process; that
    process owns the app-server connection and the conversation manager, and is
    the parent of `codex.exe app-server`. Exactly one must exist."""
    rows = process_rows(('chatgpt.exe', 'codex.exe')) if rows is None else rows
    main = next((row for row in rows if row['ProcessId'] == main_pid), None)
    if main is None:
        raise RuntimeError('Codex desktop process is not running')
    servers = {row['ParentProcessId'] for row in rows
               if row['Name'].lower() == 'codex.exe' and ' app-server' in (row.get('CommandLine') or '')}
    hosts = [row['ProcessId'] for row in rows
             if row['ParentProcessId'] == main_pid
             and row['ExecutablePath'].lower() == main['ExecutablePath'].lower()
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
                pid = entry.th32ProcessID; candidate_session = w.DWORD()
                if not kernel.ProcessIdToSessionId(pid, ctypes.byref(candidate_session)):
                    if ctypes.get_last_error() != 87:
                        raise ctypes.WinError(ctypes.get_last_error())
                elif candidate_session.value == session.value:
                    handle = kernel.OpenProcess(0x1000, False, pid)
                    if not handle:
                        # A process that disappeared is harmless; inaccessible
                        # candidates must not be mistaken for an absent desktop.
                        if ctypes.get_last_error() != 87:
                            raise ctypes.WinError(ctypes.get_last_error())
                    else:
                        try:
                            name = ctypes.create_unicode_buffer(32768); size = w.DWORD(len(name))
                            if not kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
                                raise ctypes.WinError(ctypes.get_last_error())
                            times = [w.FILETIME() for _ in range(4)]
                            if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                                raise ctypes.WinError(ctypes.get_last_error())
                            created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
                            rows.append({'ProcessId': pid, 'ParentProcessId': entry.th32ParentProcessID,
                                         'Name': entry.szExeFile, 'ExecutablePath': name.value,
                                         'Created': cim_time(created), 'CommandLine': command_line(handle)})
                        finally:
                            kernel.CloseHandle(handle)
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
    if sys.argv[1:2] == ['--app-server-host']:
        print(json.dumps({'pid': app_server_host(int(sys.argv[2]))}))
    elif sys.argv[1:2] == ['--workers']:
        print(json.dumps(process_rows(('node.exe',), set(map(int, sys.argv[2:])))))
    else:
        print(json.dumps({'processes': desktop_rows(process_rows()), 'installed': installed_packages()}))
