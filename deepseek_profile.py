"""Replace only our profile row, preserving other user/editor-managed settings."""
import re

MARKER='# desktop-session-bridge managed entry'

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
