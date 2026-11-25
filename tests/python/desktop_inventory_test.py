import datetime
import os
from pathlib import Path
import tempfile
import unittest
from desktop_inventory import _inspect_candidate, app_server_host, attach_pid, cim_time, desktop_rows, process_rows, installed_packages, visible_window


class DesktopInventoryTests(unittest.TestCase):
    def test_native_creation_time_preserves_cim_generation_precision(self):
        epoch = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
        date = datetime.datetime(2026, 11, 3, 6, 34, 37, 692126, tzinfo=datetime.timezone.utc)
        delta = date - epoch
        ticks = (delta.days * 86400 + delta.seconds) * 10000000 + delta.microseconds * 10
        self.assertEqual(cim_time(ticks + 7), '2026-11-03T06:34:37.6921260Z')
        self.assertEqual(cim_time(ticks + 7), cim_time(ticks))
        self.assertNotEqual(cim_time(ticks + 10), cim_time(ticks))

    def test_main_process_selection_excludes_electron_children_and_cli_namesakes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'desktop/resources').mkdir(parents=True)
            (root / 'desktop/resources/app.asar').touch()
            executable = str(root / 'desktop/Claude.exe')
            rows = [{'Name': 'Claude.exe', 'ProcessId': 10, 'ParentProcessId': 1,
                     'ExecutablePath': executable, 'Created': 'original'},
                    {'Name': 'Claude.exe', 'ProcessId': 11, 'ParentProcessId': 10,
                     'ExecutablePath': executable, 'Created': 'child'},
                    {'Name': 'Claude.exe', 'ProcessId': 12, 'ParentProcessId': 1,
                     'ExecutablePath': str(root / 'cli/Claude.exe'), 'Created': 'cli'}]
            self.assertEqual(desktop_rows(rows), [{'app': 'claude', 'pid': 10,
                'createdAt': 'original', 'executable': executable}])
            rows.append(dict(rows[0], ProcessId=13))
            # Preserve ambiguity for the coordinator; never pick a convenient PID.
            self.assertEqual(len(desktop_rows(rows)), 2)
            lower = dict(rows[0], Name='claude.exe', ExecutablePath=str(root / 'desktop/claude.exe'))
            # Win32 and CIM may spell the same loaded image differently. Keep
            # the existing generation stable rather than replacing its helper.
            self.assertEqual(desktop_rows([lower]), desktop_rows([rows[0]]))

    def test_codex_app_server_host_is_the_utility_that_owns_the_app_server(self):
        exe = r'C:\Program Files\WindowsApps\OpenAI.Codex_1\app\ChatGPT.exe'
        server = r'C:\Program Files\WindowsApps\OpenAI.Codex_1\app\resources\codex.exe'
        utility = '"' + exe + '" --type=utility --utility-sub-type=node.mojom.NodeService --lang=zh-CN'
        rows = [{'Name': 'ChatGPT.exe', 'ProcessId': 100, 'ParentProcessId': 1, 'ExecutablePath': exe, 'CommandLine': '"' + exe + '"'},
                {'Name': 'ChatGPT.exe', 'ProcessId': 101, 'ParentProcessId': 100, 'ExecutablePath': exe, 'CommandLine': utility},
                {'Name': 'ChatGPT.exe', 'ProcessId': 102, 'ParentProcessId': 100, 'ExecutablePath': exe, 'CommandLine': utility},
                {'Name': 'codex.exe', 'ProcessId': 201, 'ParentProcessId': 101, 'ExecutablePath': server, 'CommandLine': '"' + server + '" app-server --analytics-default-enabled'},
                {'Name': 'codex.exe', 'ProcessId': 202, 'ParentProcessId': 100, 'ExecutablePath': server, 'CommandLine': '"' + server + '" exec-server'}]
        # The Git worker (102) is also a NodeService utility; only the app server's parent qualifies.
        self.assertEqual(app_server_host(100, rows), 101)
        self.assertEqual(attach_pid(100, 'app-server-host', rows), 101)
        self.assertEqual(attach_pid(100, None, rows), 100)
        with self.assertRaisesRegex(RuntimeError, 'found 0'):
            app_server_host(100, rows[:3] + rows[4:])
        with self.assertRaisesRegex(RuntimeError, 'found 2'):
            app_server_host(100, rows + [dict(rows[3], ProcessId=203, ParentProcessId=102)])
        with self.assertRaisesRegex(RuntimeError, 'not running'):
            app_server_host(999, rows)
        with self.assertRaisesRegex(RuntimeError, 'Unsupported'):
            attach_pid(100, 'renderer', rows)

    @unittest.skipUnless(os.name == 'nt', 'Win32 window enumeration')
    def test_windowless_processes_have_no_visible_window(self):
        # PID 4 is the System process; it never owns a top-level window.
        self.assertFalse(visible_window(4))
        self.assertFalse(visible_window(0x7FFFFFF0))

    def test_orphaned_helper_of_an_exited_desktop_is_not_a_second_desktop(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'desktop/resources').mkdir(parents=True)
            (root / 'desktop/resources/app.asar').touch()
            executable = str(root / 'desktop/Claude.exe')
            main = {'Name': 'Claude.exe', 'ProcessId': 20, 'ParentProcessId': 1, 'ExecutablePath': executable,
                    'Created': 'new', 'CommandLine': '"' + executable + '" '}
            # Crash reporter of a previous instance whose main process (PID 5) exited.
            orphan = dict(main, ProcessId=21, ParentProcessId=5, Created='old',
                          CommandLine='"' + executable + '" --type=crashpad-handler --monitor-self')
            self.assertEqual([row['pid'] for row in desktop_rows([main, orphan])], [20])
            # An unreadable command line keeps the parent-based check and its ambiguity.
            self.assertEqual(len(desktop_rows([main, dict(orphan, CommandLine=None)])), 2)

    @unittest.skipUnless(os.name == 'nt', 'Win32 integration')
    def test_live_win32_snapshot_is_read_only_and_has_exact_process_identity(self):
        rows = process_rows()
        self.assertEqual(len(rows), len({row['ProcessId'] for row in rows}))
        for row in rows:
            self.assertRegex(row['Created'], r'^\d{4}-\d{2}-\d{2}T.*\.\d{6}0Z$')
            self.assertTrue(Path(row['ExecutablePath']).is_file())
        for package in installed_packages():
            self.assertIn(package['app'], ['claude', 'codex'])
            self.assertTrue(Path(package['directory']).is_dir())

    def test_access_denied_helper_is_ignored_when_main_is_known_but_root_candidate_surfaces(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'codex/resources').mkdir(parents=True)
            (root / 'codex/resources/app.asar').touch()
            exe = str(root / 'codex/ChatGPT.exe')
            main = {'Name': 'ChatGPT.exe', 'ProcessId': 100, 'ParentProcessId': 1,
                    'ExecutablePath': exe, 'Created': 't0', 'CommandLine': '"' + exe + '"'}
            denied_child = {'Name': 'ChatGPT.exe', 'ProcessId': 101, 'ParentProcessId': 100,
                            'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True}
            denied_grandchild = {'Name': 'ChatGPT.exe', 'ProcessId': 102, 'ParentProcessId': 101,
                                 'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True}
            # Inaccessible helpers under an accessible desktop main process do not fail or duplicate it.
            self.assertEqual([row['pid'] for row in desktop_rows([main, denied_child, denied_grandchild])], [100])
            # A root inaccessible desktop candidate must still surface so it is not treated as absent.
            denied_root = {'Name': 'Claude.exe', 'ProcessId': 200, 'ParentProcessId': 50,
                           'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True}
            denied_root_child = {'Name': 'Claude.exe', 'ProcessId': 201, 'ParentProcessId': 200,
                                 'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True}
            rows = desktop_rows([main, denied_child, denied_root, denied_root_child])
            self.assertEqual(rows, [
                {'app': 'codex', 'pid': 100, 'createdAt': 't0', 'executable': exe},
                {'app': 'claude', 'pid': 200, 'createdAt': None, 'executable': None, 'accessDenied': True},
            ])

    def test_inspect_candidate_handles_winerror_5_and_exited_processes(self):
        import ctypes
        def make_kernel(*, open_err=None, query_err=None, exit_code=259):
            last_error = [0]
            closed = []
            class FakeKernel:
                def ProcessIdToSessionId(self, pid, out_ptr):
                    ctypes.cast(out_ptr, ctypes.POINTER(ctypes.c_ulong))[0] = 1
                    return 1
                def OpenProcess(self, access, inherit, pid):
                    if open_err is not None:
                        last_error[0] = open_err
                        return 0
                    return 42
                def QueryFullProcessImageNameW(self, handle, flags, buf, size_ptr):
                    if query_err is not None:
                        last_error[0] = query_err
                        return 0
                    return 1
                def GetExitCodeProcess(self, handle, out_ptr):
                    ctypes.cast(out_ptr, ctypes.POINTER(ctypes.c_ulong))[0] = exit_code
                    return 1
                def GetProcessTimes(self, handle, *ptrs):
                    return 1
                def CloseHandle(self, handle):
                    closed.append(handle)
                    return 1
            return FakeKernel(), lambda: last_error[0], closed

        # OpenProcess WinError 5 -> accessDenied row instead of raising PermissionError.
        k, err_fn, closed = make_kernel(open_err=5)
        self.assertEqual(
            _inspect_candidate(10, 1, 'ChatGPT.exe', 1, k, err_fn, lambda h: None),
            {'ProcessId': 10, 'ParentProcessId': 1, 'Name': 'ChatGPT.exe',
             'ExecutablePath': None, 'Created': None, 'CommandLine': None, 'accessDenied': True},
        )
        # QueryFullProcessImageNameW WinError 5 on a still-active process -> accessDenied row and handle closed.
        k, err_fn, closed = make_kernel(query_err=5, exit_code=259)
        row = _inspect_candidate(11, 1, 'ChatGPT.exe', 1, k, err_fn, lambda h: None)
        self.assertTrue(row['accessDenied'])
        self.assertEqual(closed, [42])
        # QueryFullProcessImageNameW WinError 5 on an already-exited process -> skipped as disappeared.
        k, err_fn, closed = make_kernel(query_err=5, exit_code=0)
        self.assertIsNone(_inspect_candidate(12, 1, 'ChatGPT.exe', 1, k, err_fn, lambda h: None))
        self.assertEqual(closed, [42])
        # OpenProcess WinError 87 -> skipped as disappeared.
        k, err_fn, _ = make_kernel(open_err=87)
        self.assertIsNone(_inspect_candidate(13, 1, 'ChatGPT.exe', 1, k, err_fn, lambda h: None))
