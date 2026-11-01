"""Claude monitor entry point with verified cold-start support."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import argparse
from pathlib import Path
from native_monitor import monitor
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--launch', type=Path)
    monitor('claude', parser.parse_args().launch)
