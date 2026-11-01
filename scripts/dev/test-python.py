"""Run isolated Python tests without relying on a developer's PYTHONPATH."""
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[2]
for directory in ['scripts/lib', 'scripts/runtime', 'scripts/install', 'scripts/maintenance']:
    sys.path.insert(0, str(root / directory))
suite = unittest.defaultTestLoader.discover(str(root / 'tests/python'), pattern='*_test.py')
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(not result.wasSuccessful())
