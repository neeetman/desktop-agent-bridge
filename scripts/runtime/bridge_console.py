"""Compatibility launcher for Start menu shortcuts created by the Tk console."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
subprocess.Popen(['node', str(root/'bin/desktop-agent-bridge.mjs'), 'console'],
                 cwd=root, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
