"""Task Scheduler entry point: no console; propagate Node exit for task retry."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
root=Path(__file__).resolve().parent
directory=root/'runtime/supervisor'
directory.mkdir(parents=True,exist_ok=True)
try:
 config=json.loads((directory/'config.json').read_text(encoding='utf-8'))
 mode='watchdog' if '--watchdog' in sys.argv else 'supervisor'
 with (directory/(mode+'.stdout.log')).open('ab') as output,(directory/(mode+'.stderr.log')).open('ab') as errors:
  if mode=='watchdog':
   result=subprocess.run([config['node'],str(root/'bridge-supervisor.mjs'),'--watchdog'],cwd=root,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,creationflags=subprocess.CREATE_NO_WINDOW)
   sys.exit(result.returncode if 0<=result.returncode<=255 else 1)
  (directory/'runner.json').write_text(json.dumps({'pid':os.getpid(),'startedAt':time.time()}),encoding='utf-8')
  child=None
  attempts=0
  while True:
   healthy=False
   try:
    connection=json.loads((directory/'connection.json').read_text(encoding='utf-8'))
    request=urllib.request.Request(connection['baseUrl']+'/health',headers={'Authorization':'Bearer '+connection['token']})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request,timeout=3) as response:healthy=json.loads(response.read()).get('ok',False)
   except Exception:pass
   if healthy:
    attempts=0
   elif child is None or child.poll() is not None:
    if child is not None:
     time.sleep(min(60,2**min(attempts,6)))
    child=subprocess.Popen([config['node'],str(root/'bridge-supervisor.mjs')],cwd=root,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,creationflags=subprocess.CREATE_NO_WINDOW)
    attempts+=1
   time.sleep(2)
except Exception as error:
 with (directory/'runner-error.log').open('a',encoding='utf-8') as output:output.write(type(error).__name__+': '+str(error)+'\n')
 sys.exit(1)
