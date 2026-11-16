"""Install or check the desktop-bridge skill for every supported desktop app.

  install-bridge-skill.py            install/update all targets
  install-bridge-skill.py --plan     print what would change, write nothing
  install-bridge-skill.py --target claude --target agents

Targets: claude (~/.claude/skills), agents (~/.agents/skills, read by Codex and
DeepSeek Harness) and antigravity (skills/ in the managed Antigravity plugin).
"""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parent))
from bridge_paths import ROOT
import argparse
import json
from pathlib import Path

import bridge_skill

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--plan', action='store_true', help='print the planned changes without writing')
    parser.add_argument('--target', action='append', choices=sorted(bridge_skill.TARGET_APPS), help='limit to these targets')
    options = parser.parse_args()
    function = bridge_skill.plan if options.plan else bridge_skill.install
    print(json.dumps(function(ROOT, Path.home(), options.target), ensure_ascii=False))
