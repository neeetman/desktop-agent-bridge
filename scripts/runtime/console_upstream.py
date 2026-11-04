import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import quote

def upstream_profile(app, hashes):
    """Stage only a byte-matched adapter from a pinned upstream revision."""
    if not hashes:
        raise ValueError('The running desktop fingerprint is unavailable')
    def download(url):
        request = urllib.request.Request(url, headers={'User-Agent': 'desktop-agent-bridge-console'})
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Upstream file exceeds size limit')
        return data
    repo = 'neeetman/desktop-agent-bridge'
    revision = json.loads(download(f'https://api.github.com/repos/{repo}/commits/main'))['sha']
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('Invalid upstream revision')
    def read(relative):
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', relative) or relative.startswith('/') or '..' in relative.split('/'):
            raise ValueError('Invalid upstream path')
        return download(f'https://raw.githubusercontent.com/{repo}/{revision}/{quote(relative)}')
    catalog = json.loads(read('compat/catalog.json'))
    for name in catalog['profiles']:
        if not name.startswith(f'compat/{app}/'):
            continue
        profile = json.loads(read(name))
        if profile.get('revoked') or profile.get('app') != app or profile.get('hashes') != hashes:
            continue
        layout = json.loads(read('src/layout.json'))['files']
        files = {}
        for entry in profile['adapterFiles']:
            if not re.fullmatch(r'[A-Za-z0-9_-]+\.[a-z]+', entry):
                raise ValueError('Invalid adapter filename')
            files[entry] = read(layout[entry])
        return revision, profile, files
    raise ValueError(f'No validated {app} profile matches these bytes in upstream {revision[:10]}')



if __name__ == '__main__':
    app, destination = sys.argv[1:]
    if app not in ('claude', 'codex'):
        raise ValueError('Unsupported desktop')
    revision, profile, files = upstream_profile(app, json.load(sys.stdin))
    folder = Path(destination)
    (folder/'adapter').mkdir()
    for name, content in files.items():
        (folder/'adapter'/name).write_bytes(content)
    (folder/'profile.json').write_text(json.dumps(profile), encoding='utf8')
    print(json.dumps({'revision':revision,'id':profile['id']}))
