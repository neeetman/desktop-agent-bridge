"""Replace only our profile row, preserving other user/editor-managed settings."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import re

MARKER='# desktop-session-bridge managed entry'


def plugin_sources(root):
    """The Host release is self-contained, independent of the repository layout."""
    sources = {}
    for name in ['deepseek-plugin.mjs', 'peer-catalog.mjs', 'peer-call.mjs']:
        source = source_file(root, name).read_text(encoding='utf8')
        source = re.sub(r"from (['\"])[^'\"]*/(peer-(?:catalog|call)\.mjs)\1", lambda match: "from './" + match.group(2) + "'", source)
        sources[name] = source.encode('utf8')
    return sources

def replace_managed_block(before, replacement):
    pattern=r'(?ms)^# desktop-session-bridge managed entry\r?\n- insert:\r?\n(?:(?!^(?:- |#)).)*(?=^(?:- |#)|\Z)'
    matches=list(re.finditer(pattern,before))
    if MARKER in before:
        if len(matches)!=1:
            raise RuntimeError('Managed plugin block changed format; inspect it before updating')
        match=matches[0]; block=match.group()
        if len(re.findall(r'(?m)^ {4}-\s',block))!=1 or not re.search(r'["\']?id["\']?\s*:\s*["\']desktop-session-bridge(?:-[a-f0-9]{16})?["\']',block):
            raise RuntimeError('Managed insert contains additional or unknown entries; refusing to replace it')
        before=before[:match.start()]+before[match.end():]
    return before.rstrip()+'\n'+replacement.lstrip('\n')
