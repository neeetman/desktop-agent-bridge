import datetime
import os
from pathlib import Path
import tempfile
import unittest
from desktop_inventory import cim_time, desktop_rows, process_rows, installed_packages


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
