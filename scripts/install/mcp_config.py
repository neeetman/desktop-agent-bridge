"""Targeted edits of the desktop-bridge MCP entry in Codex and Claude user configs.

Only the keys the bridge owns change: command, args and
env.DESKTOP_BRIDGE_CLIENT_REVISION. Codex's config.toml is edited line by line,
whether the entry uses an inline `env = {...}` or a `[mcp_servers.desktop-bridge.env]`
table, and per-tool `[mcp_servers.desktop-bridge.tools.*]` tables, comments and
every other table stay byte-for-byte. The result is parsed and compared with
the original before anything is written.
"""
import copy
import difflib
import hashlib
import json
import re
import tomllib

from bridge_paths import source_file

SERVER = 'desktop-bridge'
REVISION_KEY = 'DESKTOP_BRIDGE_CLIENT_REVISION'
CLIENT_FILES = ['peer-client.mjs', 'peer-catalog.mjs', 'peer-call.mjs', 'delegations.mjs']
DEFAULTS = {'enabled': True, 'startup_timeout_sec': 20, 'tool_timeout_sec': 90}


def client_revision(root):
    return hashlib.sha256(b''.join(source_file(root, name).read_bytes() for name in CLIENT_FILES)).hexdigest()[:16]


def server_spec(root, node):
    return {'type': 'stdio', 'command': node, 'args': [str(source_file(root, 'peer-client.mjs'))],
            'env': {REVISION_KEY: client_revision(root)}}


def _is_client(value):
    return isinstance(value, str) and value.replace('/', '\\').lower().endswith('\\peer-client.mjs')


def launch(entry, spec):
    """Command and args for the entry. An existing launcher that wraps peer-client.mjs
    (for example `cmd /c node.exe ...\\peer-client.mjs`) is kept; only that path moves."""
    args = (entry or {}).get('args')
    if isinstance(args, list) and any(_is_client(arg) for arg in args) and isinstance((entry or {}).get('command'), str):
        return entry['command'], [spec['args'][0] if _is_client(arg) else arg for arg in args]
    return spec['command'], list(spec['args'])


def toml_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{ ' + ', '.join(f'{toml_key(k)} = {toml_value(v)}' for k, v in value.items()) + ' }'
    raise TypeError(type(value))


def toml_key(key):
    return key if re.fullmatch(r'[A-Za-z0-9_-]+', key) else json.dumps(key)


_NAME = r'''(?:desktop-bridge|"desktop-bridge"|'desktop-bridge')'''
_HEADER = re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*' + _NAME + r'\s*(?P<rest>(?:\.\s*[^\]]+)?)\]\s*(?:#.*)?$')
_ANY_HEADER = re.compile(r'^\s*\[')


def _sections(lines):
    """Map 'main' and 'env' to (start, end) line ranges of the desktop-bridge tables."""
    found, current = {}, None
    for index, line in enumerate(lines):
        if _ANY_HEADER.match(line):
            if current:
                found[current] = (found[current][0], index)
                current = None
            match = _HEADER.match(line)
            if match:
                rest = re.sub(r'\s', '', match.group('rest'))
                name = {'': 'main', '.env': 'env'}.get(rest)
                if name:
                    current = name
                    found[name] = (index, len(lines))
    return found


def _value_end(lines, index):
    """Index after the last line of the key/value starting at lines[index] (multi-line arrays/tables)."""
    depth, quote, position = 0, None, index
    while position < len(lines):
        text = lines[position] if position > index else lines[position].split('=', 1)[1]
        i = 0
        while i < len(text):
            char = text[i]
            if quote:
                if char == '\\' and quote == '"':
                    i += 1
                elif char == quote:
                    quote = None
            elif char in '"\'':
                quote = char
            elif char == '#':
                break
            elif char in '[{':
                depth += 1
            elif char in ']}':
                depth -= 1
            i += 1
        position += 1
        if depth <= 0:
            return position
    raise ValueError('Unterminated value in config.toml')


def _set_key(lines, section, key, rendered, newline):
    """Replace key in lines[start+1:end] or insert it after the last key line. Returns new lines."""
    start, end = section
    pattern = re.compile(r'^\s*' + re.escape(key) + r'\s*=')
    for index in range(start + 1, end):
        if pattern.match(lines[index]):
            return lines[:index] + [f'{key} = {rendered}{newline}'] + lines[_value_end(lines, index):]
    insert, index = start + 1, start + 1
    while index < end:
        if lines[index].strip() and not lines[index].lstrip().startswith('#'):
            index = insert = _value_end(lines, index)
        else:
            index += 1
    return lines[:insert] + [f'{key} = {rendered}{newline}'] + lines[insert:]


def _owned(data):
    """Drop the values the bridge owns, so the rest can be compared for unrelated changes."""
    data = copy.deepcopy(data)
    entry = data.get('mcp_servers', {}).get(SERVER)
    if isinstance(entry, dict):
        for key in ('command', 'args', *DEFAULTS):
            entry.pop(key, None)
        env = entry.get('env')
        if isinstance(env, dict):
            env.pop(REVISION_KEY, None)
            if not env:
                entry.pop('env')
        if not entry:
            data['mcp_servers'].pop(SERVER)
        if not data['mcp_servers']:
            data.pop('mcp_servers')
    return data


def update_codex(source, spec):
    """Return config.toml text with the desktop-bridge entry matching spec."""
    before = tomllib.loads(source)
    newline = '\r\n' if '\r\n' in source else '\n'
    entry = before.get('mcp_servers', {}).get(SERVER)
    revision = spec['env'][REVISION_KEY]
    if entry is None:
        block = [f'[mcp_servers.{SERVER}]', f'command = {toml_value(spec["command"])}', f'args = {toml_value(spec["args"])}',
                 *(f'{key} = {toml_value(value)}' for key, value in DEFAULTS.items()), '',
                 f'[mcp_servers.{SERVER}.env]', f'{REVISION_KEY} = {toml_value(revision)}', '']
        prefix = source.rstrip('\r\n')
        updated = (prefix + newline + newline if prefix else '') + newline.join(block)
    else:
        lines = source.splitlines(keepends=True)
        if lines and not lines[-1].endswith(('\n', '\r')):
            lines[-1] += newline
        sections = _sections(lines)
        if 'main' not in sections:
            raise ValueError('The desktop-bridge MCP entry is not a plain [mcp_servers.desktop-bridge] table; edit it manually')
        command, args = launch(entry, spec)
        for key, value in (('command', command), ('args', args)):
            if entry.get(key) != value:
                lines = _set_key(lines, _sections(lines)['main'], key, toml_value(value), newline)
        env = entry.get('env') if isinstance(entry.get('env'), dict) else {}
        if env.get(REVISION_KEY) != revision:
            sections = _sections(lines)
            if 'env' in sections:
                lines = _set_key(lines, sections['env'], REVISION_KEY, toml_value(revision), newline)
            else:
                lines = _set_key(lines, sections['main'], 'env', toml_value({**env, REVISION_KEY: revision}), newline)
        updated = ''.join(lines)
    after = tomllib.loads(updated)
    if _owned(after) != _owned(before):
        raise ValueError('Unrelated Codex configuration would change; inspect the MCP table format')
    result, (command, args) = after['mcp_servers'][SERVER], launch(entry, spec)
    if result.get('command') != command or result.get('args') != args or result.get('env', {}).get(REVISION_KEY) != revision:
        raise ValueError('Codex desktop-bridge entry could not be updated in place; edit it manually')
    return updated


def update_claude(source, spec):
    data = json.loads(source) if source is not None else {}
    servers = data.setdefault('mcpServers', {})
    entry = dict(servers.get(SERVER) or {})
    command, args = launch(entry, spec)
    entry.setdefault('type', 'stdio')
    entry.update(command=command, args=args)
    entry['env'] = {**(entry.get('env') or {}), REVISION_KEY: spec['env'][REVISION_KEY]}
    servers[SERVER] = entry
    # Keep the file's own line endings; Claude writes .claude.json without a final newline.
    ending = '\n' if source is None or source.endswith('\n') else ''
    text = json.dumps(data, ensure_ascii=False, indent=2) + ending
    return text.replace('\n', '\r\n') if source and '\r\n' in source else text


def configured_codex(source):
    entry = tomllib.loads(source or '').get('mcp_servers', {}).get(SERVER)
    return None if entry is None else {'command': entry.get('command'), 'args': entry.get('args'),
                                       'revision': (entry.get('env') or {}).get(REVISION_KEY)}


def configured_claude(source):
    entry = (json.loads(source) if source else {}).get('mcpServers', {}).get(SERVER)
    return None if entry is None else {'command': entry.get('command'), 'args': entry.get('args'),
                                       'revision': (entry.get('env') or {}).get(REVISION_KEY)}


def unified_diff(path, before, after, context=2):
    return ''.join(difflib.unified_diff((before or '').splitlines(keepends=True), after.splitlines(keepends=True),
                                       fromfile=str(path), tofile=str(path), n=context))
