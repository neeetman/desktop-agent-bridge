"""Read desktop identity through Win32, without the WMI process provider."""
import ctypes
from ctypes import wintypes as w
import datetime
import json
import os
from pathlib import Path
import re


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
            and not any(parent['ProcessId'] == row['ParentProcessId']
                        and parent['ExecutablePath'].lower() == row['ExecutablePath'].lower()
                        for parent in rows)]


def process_rows():
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
            if entry.szExeFile.lower() in ['chatgpt.exe', 'claude.exe']:
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
                                         'Created': cim_time(created)})
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
    print(json.dumps({'processes': desktop_rows(process_rows()), 'installed': installed_packages()}))
