"""Codex monitor entry point; all selection is coordinated."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
from native_monitor import monitor
if __name__ == '__main__':
    monitor('codex')
