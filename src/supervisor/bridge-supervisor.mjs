import {projectURL,sourcePath} from "../lib/paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { backoffMs, childEnvironment, matchesScript, shouldRecover, restoreAppState, installedDesktopExecutable,runningDesktopCandidates } from './supervisor-policy.mjs';
import { codexMcp } from '../adapters/codex/codex-mcp-control.mjs';
import { lifecycle } from '../adapters/claude/claude-lifecycle.mjs';
import {coordinator} from '../compat/compatibility.mjs';
import {activateProfile} from '../compat/native-management.mjs';

const ROOT=fileURLToPath(projectURL(''));
const DIRECTORY=sourcePath(ROOT,'runtime/supervisor');
fs.mkdirSync(DIRECTORY,{recursive:true});
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const atomic=(file,value)=>{const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temporary,file);};
const run=promisify(execFile);
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const config=read(path.join(DIRECTORY,'config.json'));
if(!config)throw Error('Run install-autostart.ps1 to generate the supervisor configuration');
const environment=childEnvironment(process.env,config);
const logonResult=await run('whoami.exe',['/logonid'],{windowsHide:true,timeout:10000,env:environment});
const logonId=logonResult.stdout.match(/S-1-5-5-\d+-\d+/)?.[0];
if(!logonId)throw Error('Cannot identify the interactive Windows logon session');
const existing=read(path.join(DIRECTORY,'connection.json'));
const token=existing?.token??crypto.randomBytes(32).toString('hex');
const journal=path.join(DIRECTORY,'events.jsonl');
const record=(type,data)=>{fs.appendFileSync(journal,JSON.stringify({time:new Date().toISOString(),type,...data})+'\n',{mode:0o600});};

async function snapshot(){
  const command="@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','python.exe','pythonw.exe','Claude.exe','ChatGPT.exe','codex.exe','DeepSeek Harness.exe') -and $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
  const {stdout}=await run(config.powershell,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:8*1024*1024,env:environment});
  const rows=JSON.parse(stdout.trim()||'[]');return new Map((Array.isArray(rows)?rows:[rows]).map(row=>[row.ProcessId,row]));
}
async function request(file,route='/health',method='GET',body,timeout=2500){
  const connection=read(file);if(!connection?.baseUrl)throw Error('Connection not ready');
  const response=await fetch(connection.baseUrl+route,{method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error??`HTTP ${response.status}`),{code:value.code});return value;
}
const SERVICES=[
  {name:'claude-relay',script:'claude-file-relay.mjs',connection:'runtime/claude-relay/connection.json',http:true},
  {name:'claude-attach',script:'claude-autoattach.py',connection:'runtime/claude-attach/connection.json',heartbeat:'runtime/claude-attach/heartbeat.json',python:true},
  {name:'codex-mcp',script:'codex-mcp-autoattach.py',connection:'runtime/codex-mcp/connection.json',heartbeat:'runtime/codex-mcp/heartbeat.json',python:true},
  {name:'codex',script:'bridge.mjs',connection:'runtime/connection.json',http:true,app:'codex'},
  {name:'claude',script:'claude-bridge.mjs',connection:'runtime/claude/connection.json',http:true,app:'claude'},
  {name:'deepseek',script:'deepseek-bridge.mjs',connection:'runtime/deepseek/connection.json',http:true,app:'deepseek'},
  {name:'router',script:'peer-router.mjs',connection:'runtime/router/connection.json',http:true},
];

export class Supervisor {
  constructor(){
    const previous=read(path.join(DIRECTORY,'state.json'),{});
    this.state={pid:process.pid,logonId,startedAt:new Date().toISOString(),lastTickAt:Date.now(),services:{},apps:{},paused:false,recoveries:previous.recoveries??0};
    this.services=new Map(SERVICES.filter(service=>service.name!=='deepseek'||config.apps.deepseek).map(service=>[service.name,{...service,failures:0,restarts:previous.services?.[service.name]?.restarts??0,nextStart:0,startedAt:Date.now()}]));
    this.apps=new Map(Object.entries(config.apps).map(([name,value])=>[name,restoreAppState(name,value,previous.apps,previous.logonId===logonId)]));
    this.ticking=false;this.lastDeepProbe=0;this.deepBusy=false;this.nativeFailures={codex:0,claude:0,deepseek:0};this.appWatcher=null;this.appWatcherKey='';
  }
  persist(){
    this.state.lastTickAt=Date.now();
    for(const service of this.services.values())this.state.services[service.name]={pid:service.pid??null,state:service.state??'waiting',restarts:service.restarts,failures:service.failures,lastError:service.lastError??null,nextStart:service.nextStart};
    for(const app of this.apps.values())this.state.apps[app.name]={pid:app.pid,runningExecutable:app.executable,installedExecutable:app.installedExecutable??app.executable,updatePending:!!app.pid&&!!app.installedExecutable&&app.executable!==app.installedExecutable,closedByUser:app.closedByUser,lastExitCode:app.lastExitCode??null,state:app.pid?'running':app.closedByUser?'closed_by_user':'starting'};
    atomic(path.join(DIRECTORY,'state.json'),this.state);
  }
  logHandles(name){
    const directory=path.join(DIRECTORY,'logs');fs.mkdirSync(directory,{recursive:true});
    const opened=[];
    for(const suffix of ['stdout','stderr']){
      const file=path.join(directory,`${name}.${suffix}.log`);
      try{if(fs.statSync(file).size>8*1024*1024){fs.copyFileSync(file,file+'.previous');fs.truncateSync(file,0);}}catch{}
      opened.push(fs.openSync(file,'a'));
    }
    return opened;
  }
  launch(executable,args,name){
    const handles=this.logHandles(name);
    // Detached Node/Python workers survive libuv's parent-exit job cleanup.
    // Windows PowerShell is deliberately not launched through this path.
    const child=spawn(executable,args,{cwd:ROOT,env:environment,windowsHide:true,detached:true,stdio:['ignore',...handles]});
    handles.forEach(fd=>fs.closeSync(fd));child.unref();
    child.on('error',error=>record('process.launch_error',{name,error:error.message}));return child;
  }
  async killService(service,rows,reason){
    const row=rows.get(service.pid),script=sourcePath(ROOT,service.script);
    if(!matchesScript(row,script,true))throw Error('PID identity changed; refusing termination');
    process.kill(service.pid);record('service.terminated',{name:service.name,pid:service.pid,reason});
    service.retiredPid=service.pid;service.pid=null;service.child=null;service.state='recovering';service.nextStart=Date.now()+500;
    service.restarts++;this.state.recoveries++;
  }
  async ensureService(service,rows){
    const connection=read(sourcePath(ROOT,service.connection));
    const candidate=rows.get(service.pid)??rows.get(connection?.pid);
    const valid=candidate?.ProcessId!==service.retiredPid&&matchesScript(candidate,sourcePath(ROOT,service.script),true);
    if(valid){
      if(service.pid!==candidate.ProcessId){service.pid=candidate.ProcessId;service.startedAt=Date.now();record('service.adopted',{name:service.name,pid:service.pid});}
      let healthy=false;
      try{
        if(service.http)healthy=(await request(sourcePath(ROOT,service.connection))).ok===true;
        else {const heartbeat=read(sourcePath(ROOT,service.heartbeat));healthy=heartbeat?.pid===service.pid&&Date.now()-heartbeat.time<30000;}
      }catch{}
      service.failures=healthy?0:service.failures+1;
      if(healthy){service.lastError=null;service.nextStart=0;}
      service.state=healthy?'healthy':'starting';
      if(healthy&&service.python){
        const native=read(sourcePath(ROOT,service.name==='claude-attach'?'runtime/claude-attach/status.json':'runtime/codex-mcp/monitor-status.json'));
        const states=service.name==='claude-attach'?(native?.processes??[]):[native];
        const blocked=states.find(row=>['incompatible','attachment_error','awaiting_native_callback','waiting_for_native_callback'].includes(row?.state));
        if(blocked){service.state=blocked.state;service.lastError=blocked.error??blocked.detail??blocked.event??'Native desktop attachment unavailable';}
      }
      const reason=shouldRecover({alive:true,healthy,ageMs:Date.now()-service.startedAt,failures:service.failures});
      if(reason)await this.killService(service,rows,reason);
      return;
    }
    if(service.child&&service.child.exitCode===null&&Date.now()-service.startedAt<90000){service.state='starting';return;}
    if(service.pid){record('service.exited',{name:service.name,pid:service.pid});service.pid=null;service.child=null;service.restarts++;this.state.recoveries++;}
    service.state='waiting';if(Date.now()<service.nextStart)return;
    if(service.app&&!this.apps.get(service.app)?.pid)return;
    if(service.name==='claude'){
      try{if(!(await request(sourcePath(ROOT,'runtime/claude-relay/connection.json'))).connected){service.state='waiting_for_native';return;}}
      catch{service.state='waiting_for_native';return;}
    }
    let args=[sourcePath(ROOT,service.script)];
    if(service.name==='codex'){
      const caller=read(sourcePath(ROOT,'runtime/connection.json'))?.callerThread??config.callerThread;
      args.push('--caller-thread',caller,'--state',sourcePath(ROOT,'runtime'));
    }
    if(service.name==='claude-attach'&&!this.apps.get('claude').pid&&!this.apps.get('claude').closedByUser)args.push('--launch',this.apps.get('claude').executable);
    const child=this.launch(service.python?config.python:config.node,args,service.name);
    service.child=child;service.pid=child.pid;service.retiredPid=null;service.startedAt=Date.now();service.state='starting';service.failures++;
    service.nextStart=Date.now()+backoffMs(service.failures);
    child.on('exit',(code,signal)=>{service.lastError=code===0?null:`Exited ${code??signal}`;record('service.process_exit',{name:service.name,pid:child.pid,code,signal});});
    record('service.started',{name:service.name,pid:child.pid});
  }
  updateAppWatcher(){
    const pids=Object.fromEntries([...this.apps.values()].filter(app=>app.pid).map(app=>[app.name,app.pid]));
    const key=JSON.stringify(pids);if(key===this.appWatcherKey&&this.appWatcher?.exitCode===null)return;
    if(this.appWatcher?.exitCode===null)this.appWatcher.kill();this.appWatcherKey=key;
    if(!Object.keys(pids).length)return;
    const child=spawn(config.python,[sourcePath(ROOT,'app-exit-watch.py'),key],{env:environment,windowsHide:true,stdio:['ignore','pipe','ignore']});this.appWatcher=child;child.unref();
    let buffer='';child.stdout.on('data',chunk=>{
      buffer+=chunk.toString('utf8');let index;
      while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const event=JSON.parse(line),app=this.apps.get(event.app);if(app?.pid===event.pid||(!app?.pid&&app?.previousPid===event.pid)){app.closedByUser=event.clean;app.lastExitCode=event.exitCode;app.nextStart=Date.now()+backoffMs(++app.failures,2000);record('desktop.exited',event);}}catch{}}
    });
  }
  async ensureApps(rows){
    for(const app of this.apps.values()){
      const candidates=runningDesktopCandidates(app,rows);
      if(candidates.length>1){record('desktop.ambiguous',{app:app.name});continue;}
      const found=candidates[0];
      if(found){
        app.executable=found.ExecutablePath;
        if(app.name==='deepseek'){
          const hasHost=[...rows.values()].some(row=>row.ParentProcessId===found.ProcessId&&row.CommandLine?.includes('dsh-desktop-host'));
          if(!hasHost){
            app.hostMissingAt??=Date.now();
            if(Date.now()-app.hostMissingAt>90000){process.kill(found.ProcessId);record('desktop.failed_host_recovery',{app:app.name,pid:found.ProcessId});app.hostMissingAt=null;app.lastExitCode=1;app.launchAtLogin=true;app.nextStart=Date.now()+1000;continue;}
          }else app.hostMissingAt=null;
        }
        const previous=app.previousPid;app.pid=found.ProcessId;app.missingAt=0;app.launchAtLogin=false;app.closedByUser=false;
        if(previous!==app.pid)app.lastExitCode=null;
        if(previous&&previous!==app.pid){record('desktop.generation_changed',{app:app.name,oldPid:previous,pid:app.pid});if(app.name==='codex'){const service=this.services.get('codex');if(service.pid&&rows.has(service.pid))await this.killService(service,rows,'desktop_restarted');}}
        app.previousPid=app.pid;continue;
      }
      app.pid=null;
      if(app.installedExecutable)app.executable=app.installedExecutable;
      if(app.previousPid&&!app.missingAt)app.missingAt=Date.now();
      if(app.missingAt&&Date.now()-app.missingAt<3000)continue;
      if(app.closedByUser||Date.now()<app.nextStart)continue;
      if(app.name==='claude'){
        // The Claude monitor starts it suspended and installs hooks before resume.
        const attach=this.services.get('claude-attach');
        if(attach.pid&&rows.has(attach.pid)&&Date.now()-attach.startedAt>15000)await this.killService(attach,rows,'desktop_start_needed');
        continue;
      }
      if(!app.launchAtLogin&&app.lastExitCode===0)continue;
      this.launch(app.executable,[],`desktop-${app.name}`);app.nextStart=Date.now()+15000;
      record('desktop.started',{app:app.name});
    }
    this.updateAppWatcher();
  }
  async refreshInstalledApps(rows){
    if(Date.now()-(this.lastPackageRefresh??0)<30000)return;
    this.lastPackageRefresh=Date.now();
    try{
      const command="@('OpenAI.Codex','Claude') | ForEach-Object { Get-AppxPackage -Name $_ | Sort-Object Version -Descending | Select-Object -First 1 Name,InstallLocation } | ConvertTo-Json -Compress";
      const {stdout}=await run(config.powershell,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,env:environment});
      const value=JSON.parse(stdout.trim()||'[]'),packages=Array.isArray(value)?value:[value];
      let changed=false;
      for(const app of this.apps.values()){
        const executable=installedDesktopExecutable(app.name,packages);
        if(!executable||!fs.existsSync(executable)||executable.toLowerCase()===(app.installedExecutable??app.executable).toLowerCase())continue;
        record('desktop.installation_changed',{app:app.name,previous:app.installedExecutable??app.executable,executable});
        app.installedExecutable=executable;config.apps[app.name].executable=executable;changed=true;
      }
      if(changed)atomic(path.join(DIRECTORY,'config.json'),config);
    }catch(error){record('desktop.installation_refresh_failed',{error:error.message});}
  }
  async nativeProbe(rows){
    if(this.deepBusy||Date.now()-this.lastDeepProbe<30000)return;
    this.deepBusy=true;this.lastDeepProbe=Date.now();
    try{
      for(const app of ['codex','claude','deepseek']){
        const service=this.services.get(app);if(!this.apps.get(app)?.pid||service.state!=='healthy'||Date.now()-service.startedAt<30000)continue;
        const transition=coordinator.state().apps[app]?.transition;
        if(transition?.phase==='waitingIdle'){try{await activateProfile(app,transition.to);}catch(error){service.nativeError=error.code??'ACTIVATION_DEFERRED';}continue;}
        try{await request(sourcePath(ROOT,service.connection),'/v1/threads?limit=1','GET',undefined,12000);this.nativeFailures[app]=0;}
        catch(error){
          const failures=++this.nativeFailures[app];record('native.probe_failed',{app,failures,error:error.message});
          service.nativeError=error.code??'TRANSPORT_UNAVAILABLE';
          // Protocol/version failures are not repaired by restarting services or pages.
          // Process/HTTP watchdog recovery remains independent of native compatibility.
          if(failures>=3)record('native.repair_deferred',{app,code:service.nativeError,reason:'Use compatibility doctor/idle activation; no GUI refresh performed'});
        }
      }
    }finally{this.deepBusy=false;}
  }
  async tick(){
    if(this.ticking||this.state.paused)return;this.ticking=true;this.persist();
    try{const rows=await snapshot();await this.refreshInstalledApps(rows);await this.ensureApps(rows);await Promise.allSettled([...this.services.values()].map(service=>this.ensureService(service,rows).catch(error=>{service.lastError=error.message;})));void this.nativeProbe(rows);}
    catch(error){record('supervisor.tick_error',{error:error.message});}
    finally{this.persist();this.ticking=false;}
  }
}

async function watchdog(){
  const state=read(path.join(DIRECTORY,'state.json'));let healthy=false;
  try{healthy=(await request(path.join(DIRECTORY,'connection.json'))).ok===true&&(state?.paused||Date.now()-(state?.lastTickAt??0)<60000);}catch{}
  if(healthy)return console.log('Supervisor healthy');
  if(state?.pid){const rows=await snapshot();const row=rows.get(state.pid);if(matchesScript(row,sourcePath(ROOT,'bridge-supervisor.mjs'))){process.kill(state.pid);record('watchdog.terminated_stale_supervisor',{pid:state.pid});}}
  await run(config.powershell,['-NoProfile','-NonInteractive','-Command',`Start-ScheduledTask -TaskName ${quote(config.taskName)}`],{windowsHide:true,timeout:10000,env:environment});
  record('watchdog.restarted_supervisor',{});
}

if(process.argv.includes('--watchdog')){await watchdog();}
else{
  const supervisor=new Supervisor();
  const server=http.createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.origin||req.headers.authorization!==`Bearer ${token}`)return reply(401,{error:'Local supervisor authorization required'});
    if(req.url==='/health')return reply(200,{ok:supervisor.state.paused||Date.now()-supervisor.state.lastTickAt<60000,pid:process.pid});
    if(req.method==='GET'&&req.url==='/status')return reply(200,supervisor.state);
    if(req.method==='POST'&&req.url==='/pause'){supervisor.state.paused=true;supervisor.persist();return reply(200,{paused:true});}
    if(req.method==='POST'&&req.url==='/resume'){supervisor.state.paused=false;void supervisor.tick();return reply(200,{paused:false});}
    return reply(404,{error:'Unknown supervisor endpoint'});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(43131,'127.0.0.1',resolve);});
  atomic(path.join(DIRECTORY,'connection.json'),{baseUrl:'http://127.0.0.1:43131',token,pid:process.pid});
  record('supervisor.started',{pid:process.pid});await supervisor.tick();
  setInterval(()=>void supervisor.tick(),3000);
}
