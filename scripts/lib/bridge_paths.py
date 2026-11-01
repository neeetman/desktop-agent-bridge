"""Source layout shared by executable Python scripts and test fixtures."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def source_file(root, name):
    root = Path(root)
    manifest = root / 'src/layout.json'
    layout = json.loads(manifest.read_text(encoding='utf8')) if manifest.exists() else {'schemaVersion': 1, 'files': {}}
    if layout['schemaVersion'] != 1:
        raise ValueError('Unsupported source layout')
    file = root / layout['files'].get(name, name)
    file.resolve().relative_to(root.resolve())
    return file
