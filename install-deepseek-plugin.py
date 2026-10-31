"""Insert one local plugin into the existing desktop profile, preserving its settings."""
import datetime, hashlib, json, os, pathlib, re, shutil, sys
from deepseek_profile import replace_managed_block
root=pathlib.Path(__file__).resolve().parent
profile=pathlib.Path.home()/'.dsh/profiles/desktop/cordis.patch.yml'
before=profile.read_text(encoding='utf-8-sig')
marker='# desktop-session-bridge managed entry'
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=root/'runtime/deepseek-native/backups'/stamp; backup.mkdir(parents=True,exist_ok=True)
shutil.copy2(profile,backup/profile.name)
revision=hashlib.sha256(b''.join((root/name).read_bytes() for name in ['deepseek-plugin.mjs','peer-catalog.mjs','peer-call.mjs'])).hexdigest()[:16]
release=root/'runtime/deepseek-native/releases'/revision; release.mkdir(parents=True,exist_ok=True)
for name in ['deepseek-plugin.mjs','peer-catalog.mjs','peer-call.mjs']:
 shutil.copy2(root/name,release/name)
plugin={'id':'desktop-session-bridge-'+revision,'name':str(release/'deepseek-plugin.mjs'),'config':{'directory':str(root),'node':shutil.which('node'),'port':43132}}
if '--reload' in sys.argv:
 import urllib.request
 connection=json.loads((root/'runtime/deepseek-native/connection.json').read_text())
 request=urllib.request.Request(connection['baseUrl']+'/rpc',data=json.dumps({'method':'list'}).encode(),headers={'Authorization':'Bearer '+connection['token'],'Content-Type':'application/json'})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:
  rows=json.load(response)['result']['items']
 if any(row.get('running') for row in rows): raise RuntimeError('A DeepSeek session is running; wait before reloading global tools')
 plugin['config']['reloadRevision']=stamp
# JSON flow values are valid YAML; the rest of the user's patch remains byte-for-byte text.
suffix='\n'+marker+'\n- insert:\n    - '+json.dumps(plugin,ensure_ascii=False)+'\n'
if profile.read_text(encoding='utf-8-sig')!=before: raise RuntimeError('Profile changed concurrently')
updated=replace_managed_block(before,suffix)
temporary=profile.with_name(profile.name+'.bridge.tmp'); temporary.write_text(updated,encoding='utf-8'); os.replace(temporary,profile)
print(json.dumps({'profile':str(profile),'backup':str(backup),'plugin':plugin['id']},ensure_ascii=False))
