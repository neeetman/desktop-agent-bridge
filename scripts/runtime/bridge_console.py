"""Local operator console. Network and compatibility operations run off the UI thread."""
import json
import os
from pathlib import Path
import queue
import shutil
import re
import tempfile
from urllib.parse import quote
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'bin' / 'desktop-agent-bridge.mjs'


def read_queue():
    connection = json.loads((ROOT / 'runtime/router/connection.json').read_text(encoding='utf8'))
    request = urllib.request.Request(connection['baseUrl'] + '/v1/queue',
                                     headers={'Authorization': 'Bearer ' + connection['token']})
    with urllib.request.urlopen(request, timeout=4) as response:
        return json.load(response)['messages']


def command(*args):
    result = subprocess.run([shutil.which('node') or 'node', str(CLI), *args], cwd=ROOT,
                            capture_output=True, encoding='utf8', timeout=180,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Command failed')
    return json.loads(result.stdout)


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


class Console:
    def __init__(self, window):
        self.window = window
        window.title('Desktop Agent Bridge')
        window.geometry('1100x640')
        self.events = queue.Queue()
        self.busy = set()
        self.rows = []
        tabs = ttk.Notebook(window)
        tabs.pack(fill='both', expand=True, padx=12, pady=12)
        messages = ttk.Frame(tabs, padding=10)
        updates = ttk.Frame(tabs, padding=10)
        tabs.add(messages, text='Message queue')
        tabs.add(updates, text='Desktop compatibility')
        self.query = tk.StringVar()
        ttk.Label(messages, text='Filter by message ID, session, app or status').pack(anchor='w')
        ttk.Entry(messages, textvariable=self.query).pack(fill='x', pady=6)
        self.query.trace_add('write', lambda *_: self.render())
        columns = ('stage', 'jobStatus', 'from', 'to', 'id', 'reason')
        self.table = ttk.Treeview(messages, columns=columns, show='headings', height=15)
        for col, title, width in zip(columns, ['Receipt', 'Queue state', 'From', 'To', 'Message ID', 'Reason'],
                                     [100, 90, 190, 190, 200, 200]):
            self.table.heading(col, text=title)
            self.table.column(col, width=width, minwidth=65)
        scrollbar = ttk.Scrollbar(messages, command=self.table.yview)
        self.table.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side='right', fill='y')
        self.table.pack(fill='both', expand=True)
        self.detail = tk.StringVar()
        ttk.Label(messages, textvariable=self.detail, wraplength=990).pack(fill='x')
        self.table.bind('<<TreeviewSelect>>', lambda _: self.describe())
        self.status = tk.StringVar(value='Connecting')
        ttk.Label(messages, textvariable=self.status).pack(anchor='w')
        bar = ttk.Frame(updates)
        bar.pack(fill='x')
        self.app = tk.StringVar(value='codex')
        ttk.Combobox(bar, values=['codex', 'claude'], state='readonly', textvariable=self.app,
                     width=10).pack(side='left')
        self.profile = tk.StringVar()
        ttk.Entry(bar, textvariable=self.profile, width=38).pack(side='left', padx=6)
        for label, action in [('Check / match', self.plan), ('Import local profile', self.import_profile), ('Check GitHub', self.upstream),
                              ('Activate when idle', self.activate)]:
            ttk.Button(bar, text=label, command=action).pack(side='left', padx=3)
        self.output = tk.Text(updates, wrap='word')
        self.output.pack(fill='both', expand=True, pady=8)
        self.output.insert('end', 'Check the running desktop to find its matching validated profile. '
                           'For a new build, import a trusted profile directory and check the match before activation.')
        self.refresh()
        self.window.after(100, self.collect)

    def run(self, key, operation, done):
        if key in self.busy:
            return
        self.busy.add(key)
        def work():
            try:
                self.events.put((key, done, operation(), None))
            except Exception as error:
                self.events.put((key, done, None, str(error)))
        threading.Thread(target=work, daemon=True).start()

    def collect(self):
        while not self.events.empty():
            key, done, result, error = self.events.get()
            self.busy.discard(key)
            if error:
                if key == 'queue':
                    self.status.set('Queue unavailable • ' + error)
                else:
                    self.show(error)
            else:
                done(result)
        self.window.after(100, self.collect)

    def refresh(self):
        self.run('queue', read_queue, self.update_rows)
        self.window.after(3000, self.refresh)

    def update_rows(self, rows):
        if rows != self.rows:
            self.rows = rows
            self.render()
        self.status.set(f'{len(rows)} messages • refresh every 3 seconds')

    def render(self):
        selection = self.table.selection()
        self.table.delete(*self.table.get_children())
        for row in self.rows:
            if self.query.get().casefold() not in json.dumps(row, ensure_ascii=False).casefold():
                continue
            addresses = [f"{row[key]['app']} / {row[key]['threadId']}" for key in ['from','to']]
            self.table.insert('', 'end', iid=row['id'], values=(row['stage'],row['jobStatus'],
                              *addresses,row['id'],row['reason'] or ''))
        if selection and self.table.exists(selection[0]):
            self.table.selection_set(selection[0])

    def describe(self):
        selected = self.table.selection()
        row = next((r for r in self.rows if selected and r['id'] == selected[0]), None)
        self.detail.set(json.dumps(row, ensure_ascii=False) if row else '')

    def show(self, result):
        self.output.delete('1.0','end')
        self.output.insert('end', result if isinstance(result,str) else json.dumps(result,indent=2,ensure_ascii=False))

    def plan(self):
        app, profile = self.app.get(), self.profile.get().strip()
        args = ['--profile',profile] if profile else []
        def display(result):
            if self.app.get() == app:
                self.profile.set(result.get('to', ''))
            self.show(result)
        def check():
            desktop = command('doctor','--app',app)['apps'][app]
            if desktop['phase'] == 'blocked' and not profile:
                return desktop
            plan = command('compat','plan','--app',app,*args)
            plan['installedBuild'] = desktop.get('installedBuild')
            return plan
        self.run('update',check,display)

    def import_profile(self):
        folder = filedialog.askdirectory(title='Select trusted adapter package')
        if folder:
            def display(result):
                self.profile.set(result['profileId'])
                self.show(result)
            self.run('update',lambda:command('compat','import',folder),display)

    def upstream(self):
        app = self.app.get()
        def find():
            desktop = command('doctor','--app',app)['apps'][app]
            return upstream_profile(app, (desktop.get('runningBuild') or {}).get('hashes'))
        def review(candidate):
            revision, profile, files = candidate
            if not messagebox.askyesno('Import verified build match',
                    f"Trust and import {profile['id']} from upstream revision {revision}?"):
                return
            def install():
                with tempfile.TemporaryDirectory() as temp:
                    folder = Path(temp)
                    (folder/'profile.json').write_text(json.dumps(profile), encoding='utf8')
                    (folder/'adapter').mkdir()
                    for name, content in files.items():
                        (folder/'adapter'/name).write_bytes(content)
                    return command('compat','import',temp)
            def imported(result):
                self.app.set(app)
                self.profile.set(result['profileId'])
                self.show(result)
            self.run('update',install,imported)
        self.run('update',find,review)

    def activate(self):
        app, profile = self.app.get(), self.profile.get().strip()
        if not profile:
            self.show('Check for a matching profile first.')
        elif messagebox.askyesno('Activate profile',f'Activate {profile} for {app} during idle maintenance?'):
            self.run('update',lambda:command('compat','activate','--app',app,'--profile',profile,'--when-idle'),self.show)


if __name__ == '__main__':
    window = tk.Tk()
    Console(window)
    window.mainloop()
