"""Archive expired bridge-generated protocol files, verify the archive, then unlink.

Unknown outcomes, active tasks, pending decisions, protected chats, user files and
fixed versioned guides are always retained. Default invocation is a dry run.
"""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import argparse,datetime,hashlib,json,pathlib,re,zipfile

TERMINAL={'completed','replied','failed','interrupted','expired'}
UUID=r'[a-f0-9]{8}-[a-f0-9-]{27}'
def read(file,default):
 try:return json.loads(file.read_text(encoding='utf8'))
 except (OSError,ValueError):return default
def plan(runtime,days=7,now=None):
 runtime=runtime.resolve();now=now or datetime.datetime.now(datetime.timezone.utc).timestamp()
 protected=set(read(runtime/'router/protected-threads.json',{}).get('threadIds',[]));items=[]
 for file in runtime.rglob('*'):
  if not file.is_file() or now-file.stat().st_mtime<days*86400:continue
  match=re.fullmatch(rf'(message|guide|task-callback)-({UUID})\.(md|json)',file.name)
  if not match:continue
  file.resolve().relative_to(runtime)
  kind,identifier,_=match.groups();state=read(file.parent/'state.json',{})
  record=state.get('messages' if kind=='message' else 'tasks',{}).get(identifier)
  if not record or record.get('status') not in TERMINAL:continue
  if record.get('threadId') in protected or record.get('to',{}).get('threadId') in protected or record.get('from',{}).get('threadId') in protected:continue
  if kind=='message' and state.get('jobs',{}).get(identifier,{}).get('status') not in TERMINAL:continue
  if any(d.get('taskId')==identifier and d.get('status') not in ['answered','cancelled'] for d in state.get('decisions',{}).values()):continue
  data=file.read_bytes();items.append({'path':str(file),'relative':file.relative_to(runtime).as_posix(),'sha256':hashlib.sha256(data).hexdigest()})
 return items
def archive(runtime,archive_root,items):
 runtime=runtime.resolve();archive_root=archive_root.resolve();archive_root.mkdir(parents=True,exist_ok=True)
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ');target=archive_root/f'desktop-bridge-protocol-{stamp}.zip'
 with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED) as z:
  for item in items:
   file=pathlib.Path(item['path']).resolve();file.relative_to(runtime)
   data=file.read_bytes()
   if hashlib.sha256(data).hexdigest()!=item['sha256']:raise RuntimeError('Protocol file changed; cleanup cancelled')
   z.writestr(item['relative'],data)
  z.writestr('manifest.json',json.dumps(items,indent=2))
 with zipfile.ZipFile(target) as z:
  if z.testzip():raise RuntimeError('Archive CRC verification failed')
  for item in items:
   if hashlib.sha256(z.read(item['relative'])).hexdigest()!=item['sha256']:raise RuntimeError('Archive readback hash mismatch')
 # Re-evaluate ownership/state immediately before unlink, after archive readback.
 eligible={item['path'] for item in plan(runtime)}
 removed=0
 for item in items:
  file=pathlib.Path(item['path']).resolve();file.relative_to(runtime)
  if str(file) in eligible and hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256']:file.unlink();removed+=1
 return {'archive':str(target),'archived':len(items),'removed':removed}
def main():
 parser=argparse.ArgumentParser();root=ROOT
 parser.add_argument('--runtime',type=pathlib.Path,default=root/'runtime');parser.add_argument('--archive',type=pathlib.Path,default=root/'archive');parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 items=plan(args.runtime)
 result=archive(args.runtime,args.archive,items) if args.apply and items else {'candidates':len(items),'applied':args.apply,'paths':[item['relative'] for item in items]}
 print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
