"""Attach only the bounded execution API; never touch config.toml or reload MCP."""
import pathlib,json,hashlib,subprocess,threading,sys,frida
root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'codex-execution-compatibility.json').read_text(encoding='utf8'))
device=frida.get_local_device();rows=device.enumerate_processes(scope='metadata');parents={r.pid:r for r in rows};matches=[]
for row in rows:
 exe=pathlib.Path(row.parameters.get('path',''));parent=parents.get(row.parameters.get('ppid'))
 if row.name.lower()!='chatgpt.exe' or not (exe.parent/'resources/app.asar').is_file():continue
 if parent and parent.parameters.get('path','').lower()==str(exe).lower():continue
 matches.append((row.pid,exe))
if len(matches)!=1:raise RuntimeError('Exactly one validated Codex desktop is required')
pid,exe=matches[0]
checked=[]
for file,key in [(exe,'executableSha256'),(exe.parent/'chrome.dll','chromeSha256'),(exe.parent/'resources/app.asar','asarSha256')]:
 with file.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
 if actual!=manifest[key]:raise RuntimeError(f'Unsupported desktop build; execution attachment refused before changing any thread; pid={pid}; file={file}; expected={manifest[key]}; actual={actual}; manifest={root/"codex-execution-compatibility.json"}')
 checked.append({'file':str(file),'sha256':actual})
if '--check' in sys.argv:
 print(json.dumps({'validated':True,'attached':False,'pid':pid,'executable':str(exe),'manifest':str(root/'codex-execution-compatibility.json'),'version':manifest['version'],'python':sys.executable,'files':checked}));raise SystemExit(0)
compiled=subprocess.run(['node','-e','const f=require(process.argv[1]);process.stdout.write("("+f.toString()+")("+JSON.stringify(process.argv[2])+")");',str(root/'codex-main-execution.cjs'),str(root)],capture_output=True,text=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW).stdout
source=(root/'claude-attach-agent.js').read_text(encoding='utf8').replace("Process.getModuleByName('Claude.exe')","Process.getModuleByName('chrome.dll')").replace('__APPLICATION_CODE__',json.dumps(compiled))
done=threading.Event();session=device.attach(pid);script=session.create_script(source)
def receive(m,_):
 payload=m.get('payload',{})
 if payload.get('event')=='installed':done.set()
 elif payload.get('event') in ['evaluation_failed','agent_error']:print(json.dumps(payload),flush=True)
script.on('message',receive);script.load()
try:
 if not done.wait(45):raise RuntimeError('Native main-thread callback was unavailable; global config was not touched')
finally:session.detach()
print(json.dumps({'installed':True,'pid':pid,'globalConfigTouched':False}))
