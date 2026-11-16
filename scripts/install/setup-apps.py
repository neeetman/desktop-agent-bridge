"""Show, preview or apply the desktop-bridge MCP + skill setup for every app.

  setup-apps.py plan                 status per app and the exact changes (no writes)
  setup-apps.py apply --plan-id ID   apply the previewed changes; refuses if they changed
"""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parent))
from bridge_paths import ROOT
import argparse
import json
import os
from pathlib import Path

import app_setup

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['plan', 'apply'])
    parser.add_argument('--plan-id')
    parser.add_argument('--node', help='node.exe for new entries (default: the one on PATH)')
    options = parser.parse_args()
    home = Path.home()
    codex_home = Path(os.environ.get('CODEX_HOME', home / '.codex'))
    node = options.node or app_setup.default_node()
    if not node:
        raise SystemExit('Node.js is required')
    _bridge_sys.stdout.reconfigure(encoding='utf-8')  # the console parses UTF-8 JSON
    _bridge_sys.stderr.reconfigure(encoding='utf-8')
    try:
        if options.action == 'plan':
            result = app_setup.plan(ROOT, home, codex_home, node)
        else:
            if not options.plan_id:
                raise SystemExit('--plan-id is required')
            result = app_setup.apply(ROOT, home, codex_home, node, options.plan_id)
    except (RuntimeError, ValueError, OSError) as error:
        # One line for the console; backups already taken stay under runtime/.
        raise SystemExit(f'{type(error).__name__}: {error}')
    print(json.dumps(result, ensure_ascii=False))
