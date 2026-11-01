import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_attach', Path(__file__).with_name('native-attach.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
attach_selected = module.attach
