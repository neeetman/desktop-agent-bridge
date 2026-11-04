import {projectURL,sourcePath} from "../lib/paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {generated,certifiedCapabilities} from './capability-checks.mjs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export const ROOT=fileURLToPath(projectURL(''));
const run=promisify(execFile);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const readJson=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}};
export function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
export function compatError(code,message,extra={}){return Object.assign(new Error(message),{code,status:503,dispatchNotStarted:true,dispatchStage:'notStarted',...extra});}
export function adapterDigest(root,files){return digest(canonical(Object.fromEntries([...files].sort().map(file=>[file,digest(fs.readFileSync(safeFile(root,file)))]))));}
function safeFile(root,name){if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(x=>['..','.',''].includes(x)))throw compatError('INVALID_PROFILE','Unsafe package path');const file=sourcePath(root,name);if(!file.startsWith(path.resolve(root)+path.sep))throw compatError('INVALID_PROFILE','Path escapes package');if(fs.existsSync(file)&&!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))throw compatError('INVALID_PROFILE','Package symlink escapes its root');return file;}
export function validateProfile(profile){
  if(profile.evidence?.stage==='candidate')throw compatError('INVALID_PROFILE','Structural candidates require live validation before import');
  if(profile.evidence?.stage==='messaging-verified' && (!Array.isArray(profile.capabilities)||profile.capabilities.length!==2||!['read','send'].every(cap=>profile.capabilities.includes(cap))))throw compatError('INVALID_PROFILE','Messaging evidence only covers read and send');
  const expanded=profile.evidence?.stage==='capability-verified';
  if(expanded && (!/^[a-f0-9-]{36}$/i.test(profile.evidence.runId)||!['create','permissions','mcp'].every(k=>['passed','deferred','failed','skipped','unsupported'].includes(profile.evidence.checks?.[k]?.status))))throw compatError('INVALID_PROFILE','Incomplete capability report');
  if(expanded && canonical(certifiedCapabilities(profile.app,profile.evidence.checks))!==canonical(profile.capabilities))throw compatError('INVALID_PROFILE','Profile capabilities disagree with native evidence');
  if(profile.schemaVersion!==1||profile.coreApiVersion!==(expanded?2:1)||!['codex','claude'].includes(profile.app)||!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(profile.id??'')||profile.platform!=='win32'||profile.arch!=='x64')throw compatError('INVALID_PROFILE','Unsupported profile identity or schema');
  if(!Array.isArray(profile.adapterFiles)||!profile.adapterFiles.length||!Array.isArray(profile.capabilities)||!profile.capabilities.length||!profile.manifests||!profile.evidence?.baseline)throw compatError('INVALID_PROFILE','Profile lacks adapter, capabilities, manifests or evidence');
  if(!/^[a-f0-9]{64}$/.test(profile.adapterDigest??''))throw compatError('INVALID_PROFILE','Invalid adapter digest');
  for(const key of profile.app==='codex'?['executableSha256','chromeSha256','asarSha256']:['executableSha256','asarSha256'])if(!/^[a-f0-9]{64}$/.test(profile.hashes?.[key]??''))throw compatError('INVALID_PROFILE','Invalid desktop hash');
  const allowed=expanded?['read','send','create','permissions','mcp']:profile.app==='codex'?['read','send','settings','execution','mcp']:['read','send','identity'];
  if(profile.capabilities.some(item=>!allowed.includes(item))||new Set(profile.capabilities).size!==profile.capabilities.length)throw compatError('INVALID_PROFILE','Unknown or duplicate capability');
  for(const file of profile.adapterFiles)safeFile(ROOT,file);
  for(const manifest of Object.values(profile.manifests))for(const [key,value] of Object.entries(profile.hashes))if(manifest[key]!==value)throw compatError('INVALID_PROFILE','Manifest/profile desktop hashes disagree');
  return profile;
}
export function coalesceInventory(load){
  let pending;
  return ()=>pending??=(Promise.resolve().then(load).finally(()=>{pending=null;}));
}
async function readWin32Inventory(args) {
  let python='python';try{python=readJson(path.join(ROOT,'runtime/supervisor/config.json')).python??python;}catch{}
  const {stdout}=await run(python,[sourcePath(ROOT,'desktop_inventory.py'),...args],{windowsHide:true,timeout:5000,maxBuffer:2*1024*1024});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}

export function verifyWorker(record, processInfo) {
  // A record is written by the worker while it is running. A process born
  // after that observation cannot be that worker, even with the same PID.
  return processInfo?.Name?.toLowerCase() === 'node.exe' &&
    processInfo.ProcessId === record.pid &&
    Date.parse(processInfo.Created) <= Date.parse(record.at);
}

export const desktopInventory=coalesceInventory(async()=>{
  if(process.platform!=='win32')return {processes:[],installed:[]};
  const data=await readWin32Inventory([]);
  if(!Array.isArray(data.processes)||!Array.isArray(data.installed))throw compatError('PROCESS_SNAPSHOT_UNAVAILABLE','Invalid native desktop inventory');
  return data;
});
export class Compatibility {
  constructor(root=ROOT,{inventory=desktopInventory,now=Date.now,alive}={}){this.root=path.resolve(root);this.directory=path.join(this.root,'runtime/updates');this.file=path.join(this.directory,'state.json');this.inventory=inventory;this.now=now;this.alive=alive??(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});}
  state(){const value=readJson(this.file,{schemaVersion:1,apps:{},leases:{},journal:[]});if(value.schemaVersion!==1||!value.apps||!value.leases||!Array.isArray(value.journal))throw compatError('STATE_SCHEMA_UNSUPPORTED','Compatibility state schema is unsupported; no state was changed');return value;}
  async locked(fn){
    fs.mkdirSync(this.directory,{recursive:true});let python='python';try{python=readJson(path.join(this.root,'runtime/supervisor/config.json')).python??python;}catch{}
    const child=spawn(python,[sourcePath(ROOT,'coordinator-lock.py'),path.join(this.directory,'coordinator.lock')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let acquired=false;
    child.stderr.resume();child.stdin.on('error',()=>{});
    try{
      await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(compatError('COORDINATOR_BUSY','Coordinator lock timed out')),8000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',()=>{clearTimeout(timer);if(!acquired)reject(compatError('COORDINATOR_BUSY','Coordinator lock could not be acquired'));});child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('"locked":true')){acquired=true;clearTimeout(timer);resolve();}});});
      return await fn();
    }finally{const exited=child.exitCode!==null||!child.pid?Promise.resolve():new Promise(resolve=>child.once('close',resolve));child.stdin.end('release\n');if(!acquired)child.kill();await exited;}
  }
  profiles(){
    const catalog=readJson(path.join(this.root,'compat/catalog.json'));if(catalog.schemaVersion!==1||!Array.isArray(catalog.profiles))throw compatError('INVALID_PROFILE','Invalid compatibility catalog');
    // A resident v1 client must still be able to load its catalog after a v2 import.
    const local=['imports.json','history.json','imports-v2.json','history-v2.json'].flatMap(file=>readJson(path.join(this.directory,file),[]));
    const result=[...catalog.profiles.map(file=>({profile:readJson(safeFile(this.root,file)),adapterRoot:this.root})),...local.map(item=>({profile:readJson(path.join(this.directory,'packages',item.digest,'profile.json')),adapterRoot:path.join(this.directory,'packages',item.digest,'adapter')}))];
    const ids=new Map();for(const row of result){validateProfile(row.profile);const id=row.profile.app+':'+row.profile.id,previous=ids.get(id);if(previous&&canonical({...previous.profile,revoked:false})!==canonical({...row.profile,revoked:false}))throw compatError('INVALID_PROFILE','A profile ID cannot be reused for different contents');if(previous?.profile.revoked||(catalog.revoked??[]).includes(id))row.profile={...row.profile,revoked:true};ids.set(id,row);}
    const rows=[...ids.values()];
    for(const row of rows){
      if(!generated(row.profile))continue;
      const seed=ids.get(row.profile.app+':'+row.profile.evidence.seed);
      if(!seed||seed.profile.revoked||seed.profile.adapterDigest!==row.profile.adapterDigest)
        row.profile={...row.profile,revoked:true};
    }
    return rows;
  }
  pin(selected){
    const hash=digest(canonical(selected.profile)),target=path.join(this.directory,'packages',hash),adapterRoot=path.join(target,'adapter');
    if(!fs.existsSync(path.join(target,'profile.json'))){fs.mkdirSync(adapterRoot,{recursive:true});for(const name of selected.profile.adapterFiles){const file=safeFile(adapterRoot,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(safeFile(selected.adapterRoot,name),file);}if(adapterDigest(adapterRoot,selected.profile.adapterFiles)!==selected.profile.adapterDigest)throw compatError('ADAPTER_STALE','Adapter changed while copying immutable snapshot');atomicJson(path.join(target,'profile.json'),selected.profile);}
    const historyFile=path.join(this.directory,selected.profile.coreApiVersion===2?'history-v2.json':'history.json');
    const history=readJson(historyFile,[]);if(!history.some(item=>item.digest===hash)){history.push({digest:hash});atomicJson(historyFile,history);}
    return {...selected,adapterRoot};
  }
  identity(){
    const file=path.join(this.directory,'installation.json');let identity=readJson(file,null);
    if(identity&&identity.root!==this.root)throw compatError('IDENTITY_MISMATCH','Installation state was copied from another directory; reinitialize explicitly');
    if(!identity){identity={installationId:crypto.randomUUID(),root:this.root};atomicJson(file,identity);}return identity;
  }
  fileFingerprint(executable,app){
    const files={executableSha256:executable,asarSha256:path.join(path.dirname(executable),'resources/app.asar'),...(app==='codex'?{chromeSha256:path.join(path.dirname(executable),'chrome.dll')}:{})};
    return {files,stamp:canonical(Object.entries(files).map(([key,file])=>{const s=fs.statSync(file,{bigint:true});return [key,path.resolve(file),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)];}))};
  }
  evaluate(app,inventory,state,requestedId){
    const processes=inventory.processes.filter(row=>row.app===app);if(processes.length!==1)throw compatError(processes.length?'AMBIGUOUS_DESKTOP':'DESKTOP_NOT_RUNNING',`Exactly one ${app} desktop main process is required`);
    const processInfo=processes[0],generation=digest(canonical(processInfo));const old=state.apps[app]??{};
    const {files,stamp}=this.fileFingerprint(processInfo.executable,app);
    let hashes;
    if(old.generation===generation&&old.fileStamp&&old.fileStamp!==stamp){
      // Windows ctime also changes for metadata updates. Revalidate every byte
      // only when path, file ID, size and mtime stayed identical; real file
      // replacement or content changes still require a new desktop process.
      const contentStamp=value=>canonical(JSON.parse(value).map(row=>row.slice(0,-1)));
      if(contentStamp(old.fileStamp)!==contentStamp(stamp))throw compatError('AWAITING_RESTART','Desktop files changed within the running process generation');
      hashes=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,digest(fs.readFileSync(file))]));
      if(canonical(hashes)!==canonical(old.runningBuild?.hashes))throw compatError('AWAITING_RESTART','Desktop files changed within the running process generation');
    }
    hashes??=old.generation===generation&&old.fileStamp===stamp?old.runningBuild.hashes:Object.fromEntries(Object.entries(files).map(([key,file])=>[key,digest(fs.readFileSync(file))]));
    const matches=this.profiles().filter(row=>row.profile.app===app&&Object.entries(hashes).every(([key,value])=>row.profile.hashes[key]===value));
    let chosen=matches.find(row=>row.profile.id===(requestedId??(old.generation===generation?old.profileId:undefined)))??(!requestedId?matches.find(row=>!row.profile.revoked):undefined);
    if(!chosen)throw compatError('BUILD_UNSUPPORTED',`No validated ${app} profile matches the running desktop bytes`,{runningBuild:{...processInfo,hashes},fileStamp:stamp,generation});
    const {profile,adapterRoot}=chosen;if(profile.revoked)throw compatError('PROFILE_REVOKED','Selected compatibility profile was revoked');
    if(adapterDigest(adapterRoot,profile.adapterFiles)!==profile.adapterDigest)throw compatError('ADAPTER_STALE','Adapter bytes no longer match the validated profile');
    return {profile,adapterRoot,profileDigest:digest(canonical(profile)),generation,fileStamp:stamp,runningBuild:{...processInfo,hashes,packageVersion:profile.packageVersion,observedPackageVersion:processInfo.executable.match(/_(\d+(?:\.\d+){2,3})_/)?.[1]??null},installedBuild:inventory.installed.find(row=>row.app===app)??null};
  }
  save(state,event){if(event){state.journal.push({at:new Date(this.now()).toISOString(),...event});state.journal=state.journal.slice(-1000);}atomicJson(this.file,state);}
  async resolve(app,capability,{pid,lease=false}={}){
    const inventory=await this.inventory();return this.locked(()=>{
      const state=this.state(),identity=this.identity();let selected;
      try{selected=this.evaluate(app,inventory,state);}catch(error){const old=state.apps[app]??{};state.apps[app]={...old,...error.runningBuild?{runningBuild:error.runningBuild,fileStamp:error.fileStamp,generation:error.generation}:{},phase:'blocked',blockedReason:error.code,lastError:error.message};this.save(state);throw error;}
      const old=state.apps[app]??{};
      if(pid&&selected.runningBuild.pid!==pid)throw compatError('IDENTITY_MISMATCH','Requested PID is not the selected desktop main process');
      const required=selected.profile.coreApiVersion===2&&app==='codex'&&capability==='execution'?'create':capability;
      if(!selected.profile.capabilities.includes(required))throw compatError('CAPABILITY_UNSUPPORTED',`${capability} is not validated for this build`);
      const circuit=old.circuits?.[capability];if(circuit&&circuit.generation===selected.generation&&circuit.profileDigest===selected.profileDigest)throw compatError('CONTRACT_MISMATCH',`${capability} is blocked after a native contract mismatch; activate a validated profile or restart/probe during maintenance`);
      if(old.transition&&old.transition.generation===selected.generation)throw compatError('REFRESH_DEFERRED_BUSY','An adapter transition is waiting for safe activation');
      if(old.transition){old.transition=null;this.save(state,{app,event:'transition.recoveredAfterProcessRestart'});}
      const connection=readJson(path.join(this.root,app==='codex'?'runtime/connection.json':'runtime/claude-relay/connection.json'),null);
      if(!connection?.token)throw compatError('CREDENTIALS_NOT_READY','Start the local HTTP/relay service before native attachment');
      const credentialDigest=digest(connection.token);const changed=old.generation!==selected.generation||old.profileDigest!==selected.profileDigest||old.credentialDigest!==credentialDigest;
      if(changed&&old.generation===selected.generation&&['ready','attached'].includes(old.phase))throw compatError('ADAPTER_STALE','Live helper selection changed; use idle activation or restart the desktop during maintenance');
      const activationEpoch=(old.activationEpoch??0)+(changed?1:0),credentialEpoch=(old.credentialEpoch??0)+(old.credentialDigest!==credentialDigest?1:0);
      const binding={installationId:identity.installationId,root:this.root,credentialEpoch,generation:selected.generation,activationEpoch,profileDigest:selected.profileDigest,adapterDigest:selected.profile.adapterDigest};
      selected=this.pin(selected);
      const row={...old,...selected,circuits:changed?{}:old.circuits??{},profileId:selected.profile.id,binding,credentialDigest,credentialEpoch,activationEpoch,phase:changed?'selected':old.phase==='blocked'?'selected':old.phase??'selected',blockedReason:null};
      state.apps[app]=row;
      const result={app,...selected,binding};
      if(lease){result.leaseId=crypto.randomUUID();state.leases[result.leaseId]={app,pid:process.pid,createdAt:this.now(),expiresAt:this.now()+120000,binding};}
      this.save(state,changed?{app,event:'selection',profileId:row.profileId,generation:row.generation,activationEpoch}:undefined);return result;
    });
  }
  async release(id){return this.locked(()=>{const state=this.state();delete state.leases[id];this.save(state);});}
  async trip(app,capability,binding){return this.locked(()=>{const state=this.state(),row=state.apps[app];if(row&&sameBinding(row.binding,binding)){row.circuits??={};row.circuits[capability]={generation:binding.generation,profileDigest:binding.profileDigest,at:new Date(this.now()).toISOString()};this.save(state,{app,event:'capability.contractMismatch',capability});}});}
  async report(app,binding,phase,details={}){return this.locked(()=>{const state=this.state(),row=state.apps[app];if(!row||row.phase==='blocked'||row.transition||canonical(row.binding)!==canonical(binding))throw compatError('CONFIG_EPOCH_CHANGED','Stale helper observation rejected');row.phase=phase;row.probe={at:new Date(this.now()).toISOString(),...details};row.helperProbes??={};row.helperProbes[details.kind??'monitor']=row.probe;this.save(state);return {reported:true};});}
  async doctor(app){
    const inventory=await this.inventory(),state=this.state();const apps={};
    for(const name of app?[app]:['codex','claude']){try{const row=this.evaluate(name,inventory,state);apps[name]={runningBuild:row.runningBuild,installedBuild:row.installedBuild,profileId:row.profile.id,profileDigest:row.profileDigest,adapterDigest:row.profile.adapterDigest,capabilities:row.profile.capabilities,phase:state.apps[name]?.phase??'notAttached',probe:state.apps[name]?.probe??null,circuits:state.apps[name]?.circuits??{},transition:state.apps[name]?.transition??null};}catch(error){apps[name]={phase:'blocked',installedBuild:inventory.installed.find(row=>row.app===name)??null,runningBuild:error.runningBuild??null,code:error.code??'DIAGNOSTIC_ERROR',error:error.message};}}
    const workerDirectory = path.join(this.root,'runtime/router/mcp-workers');
    const workers = [];
    if (fs.existsSync(workerDirectory)) {
      for (const name of fs.readdirSync(workerDirectory).filter(name => /^\d+\.json$/.test(name))) {
        const record = readJson(path.join(workerDirectory,name));
        workers.push({...record,alive:false});
      }
    }
    const candidates = workers.filter(record => Number.isSafeInteger(record.pid) && record.pid > 0 && this.alive(record.pid));
    if (candidates.length) {
      try {
        const rows = await readWin32Inventory(['--workers', ...candidates.map(row => String(row.pid))]);
        const byPid = new Map(rows.map(row => [row.ProcessId,row]));
        for (const record of candidates) record.alive = verifyWorker(record, byPid.get(record.pid));
      } catch {
        for (const record of candidates) record.alive = null;
      }
    }
    return {passive:true,attached:false,apps,workers};
  }
  async plan(app,profileId){const inventory=await this.inventory();const state=this.state(),selected=this.evaluate(app,inventory,state,profileId);return {app,from:state.apps[app]?.profileId??null,to:selected.profile.id,generation:selected.generation,requiresIdle:true,requiresHelperProbe:true,rollbackPossible:!!state.apps[app]?.previousProfileId,protected:readJson(path.join(this.root,'runtime/router/protected-threads.json'),{threadIds:[]}).threadIds.length>0};}
  async activate(app,profileId,{idleProbe,attachProbe}={}){
    const inventory=await this.inventory();let transition;const runner={pid:process.pid,id:crypto.randomUUID(),expiresAt:this.now()+180000};
    await this.locked(()=>{
      const state=this.state(),selected=this.pin(this.evaluate(app,inventory,state,profileId)),old=state.apps[app];
      if(!old)throw compatError('NOT_INITIALIZED','Resolve the running desktop before activation');
      if(readJson(path.join(this.root,'runtime/router/protected-threads.json'),{threadIds:[]}).threadIds.length)throw compatError('REFRESH_DEFERRED_PROTECTED','Protected chats block helper replacement');
      for(const item of Object.values(state.leases))if(item.app===app&&item.expiresAt>this.now()&&this.alive(item.pid))throw compatError('REFRESH_DEFERRED_BUSY','Native requests are still in flight');
      if(old.transition){if(old.transition.phase!=='waitingIdle'||old.transition.to!==profileId)throw compatError('REFRESH_DEFERRED_BUSY','A previous transition must be recovered first');if(old.transition.runner?.expiresAt>this.now()&&this.alive(old.transition.runner.pid))throw compatError('REFRESH_DEFERRED_BUSY','Another activation runner owns this transition');if(old.transition.candidate.profileDigest!==selected.profileDigest||old.transition.generation!==selected.generation)throw compatError('CONFIG_EPOCH_CHANGED','Pending activation candidate changed; cancel or recover it first');transition=old.transition;transition.runner=runner;this.save(state);return;}
      transition={id:crypto.randomUUID(),runner,from:old.profileId,to:profileId,generation:selected.generation,phase:'waitingIdle',candidate:selected,previous:structuredClone({...old,transition:undefined})};
      old.transition=transition;this.save(state,{app,event:'transition.prepared',id:transition.id});
    });
    try{
      const idle=await idleProbe?.(transition.previous);if(!idle?.authoritative||!idle.idle)throw compatError('REFRESH_DEFERRED_BUSY','Native global idle/approval state is not confirmed');
      const binding={...transition.previous.binding,activationEpoch:transition.previous.activationEpoch+1,profileDigest:transition.candidate.profileDigest,adapterDigest:transition.candidate.profile.adapterDigest};
      await this.locked(()=>{const state=this.state(),current=state.apps[app].transition;if(current?.id!==transition.id||current.runner?.id!==runner.id||current.phase!=='waitingIdle')throw compatError('CONFIG_EPOCH_CHANGED','Activation ownership changed');current.phase='attaching';current.binding=binding;this.save(state,{app,event:'transition.attaching',id:transition.id});});
      const result=await attachProbe?.({...transition.candidate,app,binding});
      if(!result?.ready||canonical(result.binding)!==canonical(binding))throw compatError('CONTRACT_MISMATCH','Candidate helper probe did not confirm binding/readiness');
      await this.locked(async()=>{const state=this.state(),current=state.apps[app];if(current.transition?.id!==transition.id)throw compatError('CONFIG_EPOCH_CHANGED','Transition changed concurrently');const checked=this.pin(this.evaluate(app,await this.inventory(),state,profileId));if(checked.generation!==transition.generation||checked.profileDigest!==transition.candidate.profileDigest)throw compatError('CONFIG_EPOCH_CHANGED','Desktop/profile changed during activation');state.apps[app]={...transition.previous,...checked,profileId,previousProfileId:transition.from,binding,activationEpoch:binding.activationEpoch,phase:'ready',circuits:{},transition:null};this.save(state,{app,event:'transition.committed',id:transition.id});});
      return {activated:true,profileId,binding};
    }catch(error){await this.locked(()=>{const state=this.state();const row=state.apps[app];if(row?.transition?.id===transition.id&&row.transition.runner?.id===runner.id){row.transition.phase=row.transition.phase==='attaching'?'recoveryRequired':'waitingIdle';delete row.transition.runner;row.transition.error=error.code??'ATTACHMENT_ERROR';this.save(state,{app,event:'transition.deferred',id:transition.id,code:error.code});}});throw error;}
  }
  async recover(app){return this.locked(()=>{const state=this.state(),row=state.apps[app],transition=row?.transition;if(!transition)return {recovered:false};if(transition.phase!=='waitingIdle')throw compatError('RECOVERY_REQUIRED','Attachment may have started; restart the desktop before clearing transition');if(transition.runner?.expiresAt>this.now()&&this.alive(transition.runner.pid))throw compatError('REFRESH_DEFERRED_BUSY','A live activation runner still owns this transition');row.transition=null;this.save(state,{app,event:'transition.cancelled',id:transition.id});return {recovered:true};});}
  async importPackage(directory){
    directory=path.resolve(directory);const profile=validateProfile(readJson(path.join(directory,'profile.json'))),adapterRoot=path.join(directory,'adapter');
    if(adapterDigest(adapterRoot,profile.adapterFiles)!==profile.adapterDigest)throw compatError('ADAPTER_STALE','Imported package digest does not match');
    const importsFile=path.join(this.directory,profile.coreApiVersion===2?'imports-v2.json':'imports.json');
    return this.locked(()=>{const list=readJson(importsFile,[]),hash=digest(canonical(profile)),target=path.join(this.directory,'packages',hash);
      const existing=this.profiles().find(row=>row.profile.id===profile.id&&row.profile.app===profile.app);
      if(existing){
        if(!existing.profile.revoked && canonical(existing.profile)===canonical(profile) &&
            adapterDigest(existing.adapterRoot,profile.adapterFiles)===profile.adapterDigest){
          return {imported:false,alreadyAvailable:true,profileId:profile.id};
        }
        throw compatError('INVALID_PROFILE','Profile ID already exists with different contents or is revoked');
      }
      fs.mkdirSync(path.join(target,'adapter'),{recursive:true});for(const file of profile.adapterFiles){const from=safeFile(adapterRoot,file);if(fs.lstatSync(from).isSymbolicLink())throw compatError('INVALID_PROFILE','Package symlinks are forbidden');const to=safeFile(path.join(target,'adapter'),file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}if(adapterDigest(path.join(target,'adapter'),profile.adapterFiles)!==profile.adapterDigest)throw compatError('ADAPTER_STALE','Imported adapter changed while copying');atomicJson(path.join(target,'profile.json'),profile);list.push({digest:hash});atomicJson(importsFile,list);return {imported:true,profileId:profile.id};});
  }
}
const coordinator=new Compatibility();
export async function withCapability(app,capability,operation){
  const selection=await coordinator.resolve(app,capability,{lease:true});
  try{return await operation(selection);}catch(error){if(error.code==='CONTRACT_MISMATCH'){try{await coordinator.trip(app,capability,selection.binding);}catch{}}throw error;}finally{try{await coordinator.release(selection.leaseId);}catch{/* Preserve the native outcome. A stranded lease expires and only delays activation. */}}
}
export function sameBinding(a,b){return !!a&&!!b&&canonical(a)===canonical(b);}
export {coordinator};
