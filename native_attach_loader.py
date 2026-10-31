import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_attach', Path(__file__).with_name('native-attach.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
attach_selected = module.attach
