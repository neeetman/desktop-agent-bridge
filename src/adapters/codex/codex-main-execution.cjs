function install(root,config={}){
 if(process.type!=='browser')return JSON.stringify({installed:false});const req=process.mainModule.require.bind(process.mainModule);if(!req('node:worker_threads').isMainThread)return JSON.stringify({installed:false});
 const fs=req('node:fs'),path=req('node:path'),net=req('node:net'),crypto=req('node:crypto'),inspector=req('node:inspector'),{app}=req('electron');
 const adapterRoot=config.adapterRoot??root,manifest=config.manifest??JSON.parse(fs.readFileSync(path.join(root,'codex-execution-compatibility.json'),'utf8'));
 const guard=config.binding?req(path.join(adapterRoot,'helper-binding.cjs')).createGuard(root,'codex',config.binding):null;
 const reused=guard?guard.replacement(globalThis.__codexExecutionBridge):globalThis.__codexExecutionBridge?.revision===manifest.helperRevision;
 if(reused&&globalThis.__codexExecutionBridge.server.listening)return JSON.stringify({installed:true,reused:true,pid:process.pid});
 if(globalThis.__codexExecutionBridge?.busy)return JSON.stringify({installed:false,reason:'execution bridge busy'});
 globalThis.__codexExecutionBridge?.dispose?.();globalThis.__codexExecutionBridge?.server.close();delete req('node:module')._cache[path.join(adapterRoot,'execution-policy.cjs')];
 const policy=req(path.join(adapterRoot,'execution-policy.cjs')),token=JSON.parse(fs.readFileSync(path.join(root,'runtime/connection.json'),'utf8')).token;
 const api={busy:0,binding:config.binding,revision:manifest.helperRevision},managed=new Set(Object.keys(policy.loadState().threads)),audits=new Map(),disposers=[];api.dispose=()=>disposers.splice(0).forEach(fn=>fn());let creationTail=Promise.resolve();
 function observe(id,c,approval=false){if(!managed.has(id))return;const a=audits.get(id)??{startedAt:new Date().toISOString(),observations:0,approvalRequestEvents:0,waitingOnApprovalEvents:0,statuses:[]};a.observations++;if(approval)a.approvalRequestEvents++;const status=c?.threadRuntimeStatus;if(status){const key=JSON.stringify(status);if(!a.statuses.includes(key))a.statuses.push(key);if(/waitingOnApproval/i.test(key))a.waitingOnApprovalEvents++;}audits.set(id,a);}
 let managerPromise;
 async function manager(){
  if(globalThis.__codexExecutionManager?.hostId==='local'&&!globalThis.__codexExecutionManager.disposed)return globalThis.__codexExecutionManager;
  if(managerPromise)return managerPromise;
  managerPromise=(async()=>{const session=new inspector.Session();session.connect();const post=(m,p)=>new Promise((r,j)=>session.post(m,p,(e,v)=>e?j(e):r(v)));
   try{
    const ctor=await req(path.join(adapterRoot,'codex-runtime.cjs')).connectionConstructor(manifest);globalThis.__codexExecutionPrototype=ctor.prototype;
    const proto=await post('Runtime.evaluate',{expression:'globalThis.__codexExecutionPrototype'}),objects=await post('Runtime.queryObjects',{prototypeObjectId:proto.result.objectId});
    await post('Runtime.callFunctionOn',{objectId:objects.objects.objectId,functionDeclaration:'function(){globalThis.__codexExecutionConnection=this.find(x=>x.options?.hostId==="local"&&!x.disposed&&x.connectionState==="connected");return true}',returnByValue:true});
    const fn=await post('Runtime.evaluate',{expression:'globalThis.__codexExecutionConnection.options.getStatsigEvaluations'}),props=await post('Runtime.getProperties',{objectId:fn.result.objectId,ownProperties:false}),scopes=props.internalProperties.find(x=>x.name==='[[Scopes]]'),list=await post('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
    for(const row of list.result){if(!row.value?.description?.startsWith('Closure'))continue;const vars=await post('Runtime.getProperties',{objectId:row.value.objectId,ownProperties:true}),entry=vars.result.find(x=>x.name===manifest.managerClass);if(!entry?.value?.objectId)continue;
     await post('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(){globalThis.__codexExecutionPrototype=this.prototype;return true}',returnByValue:true});const p=await post('Runtime.evaluate',{expression:'globalThis.__codexExecutionPrototype'}),o=await post('Runtime.queryObjects',{prototypeObjectId:p.result.objectId});
     await post('Runtime.callFunctionOn',{objectId:o.objects.objectId,functionDeclaration:'function(){globalThis.__codexExecutionManager=this.find(x=>x.hostId==="local"&&!x.disposed&&typeof x.startConversation==="function");return true}',returnByValue:true});
    }
    if(!globalThis.__codexExecutionManager)throw Error('Native local conversation manager unavailable');return globalThis.__codexExecutionManager;
   }finally{session.disconnect();}
  })().finally(()=>managerPromise=null);return managerPromise;
 }
 const inputs=m=>({hasDesktopRuntime:true,hasLocalRuntime:true,hasDeveloperInstructions:true,isBrowserRuntime:false,usesDesktopMcp:m.settings.usesDesktopMcp,readDynamicTools:m.settings.readDynamicTools,sidebarSectionToolsEnabled:true,everydayWork:false});
 function lastTurnContext(file){if(!file)return null;let fd;try{fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,1024*1024));fs.readSync(fd,buffer,0,buffer.length,size-buffer.length);const rows=buffer.toString('utf8').split('\n');for(let n=rows.length-1;n>=0;n--){let row;try{row=JSON.parse(rows[n]);}catch{continue;}if(row.type!=='turn_context')continue;const p=row.payload;return {at:row.timestamp,turnId:p.turn_id??p.id??null,cwd:p.cwd,model:p.model,reasoningEffort:p.effort,approvalPolicy:p.approval_policy,sandboxPolicy:p.sandbox_policy,source:'native-rollout-turn-context'};}return null;}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}}
 let observedManager;async function observeManager(){const m=await manager();if(observedManager!==m){disposers.push(m.addConversationStateCallback((id,c)=>observe(id,c)),m.addApprovalRequestListener(e=>observe(e.conversationId??e.threadId,m.getConversation(e.conversationId??e.threadId),true)),globalThis.__codexExecutionConnection.registerInternalNotificationHandler(e=>{const p=e.params;if(e.method==='thread/status/changed'&&p?.threadId)observe(p.threadId,{threadRuntimeStatus:p.status});}));observedManager=m;}return m;}
 async function snapshot(threadId){const m=await observeManager(),c=m.getConversation(threadId);if(!c)return {loaded:false,threadId,projectAssignment:await m.getThreadProjectAssignment(threadId)};observe(threadId,c);const effective=c.currentPermissions??{},next=c.latestThreadSettings??{},last=lastTurnContext(c.rolloutPath),sandbox=last?.sandboxPolicy??next.sandboxPolicy??effective.sandboxPolicy;
  return {loaded:true,threadId,cwd:c.cwd,model:c.latestModel,reasoningEffort:c.latestReasoningEffort,sandboxMode:['workspaceWrite','workspace-write'].includes(sandbox?.type)?'workspace-write':['readOnly','read-only'].includes(sandbox?.type)?'read-only':['dangerFullAccess','danger-full-access'].includes(sandbox?.type)?'danger-full-access':null,writableRoots:sandbox?.writableRoots??sandbox?.writable_roots??[],approvalPolicy:last?.approvalPolicy??next.approvalPolicy??effective.approvalPolicy??null,permissionScope:last?'native-last-executed-turn':next.sandboxPolicy?'native-next-turn-settings':'native-current-permissions',nativeSandboxPolicy:sandbox??null,lastObservedCurrentPermissions:effective,nativeLastTurnContext:last,nextTurnPermissions:policy.describePermissions(next.sandboxPolicy??effective.sandboxPolicy,next.approvalPolicy??effective.approvalPolicy),nativeNextTurnSettings:{cwd:next.cwd,approvalPolicy:next.approvalPolicy,sandboxPolicy:next.sandboxPolicy,permissions:next.permissions},pendingRequests:c.requests?.map(r=>({id:r.id,method:r.method,type:r.type}))??[],nativeRuntimeStatus:c.threadRuntimeStatus,nativeExecutionState:m.getThreadExecutionState(threadId),permissionAudit:audits.get(threadId),projectAssignment:await m.getThreadProjectAssignment(threadId),source:'native-desktop-conversation-state'};
 }
 async function idleConversation(threadId,saved){
  const m=await manager(),busy=()=>m.getThreadExecutionState(threadId)?.inProgress||m.getConversation(threadId)?.requests?.length;
  if(busy())throw Object.assign(Error('Thread is active or awaiting approval; permissions were not changed'),{status:409});
  try{if((await m.readThread(threadId,{includeTurns:false})).thread?.status?.type==='active')throw Object.assign(Error('Thread is active; permissions were not changed'),{status:409});}catch(e){if(!/thread not found|thread.*not loaded/i.test(e.message))throw e;}
  const existing=m.getConversation(threadId),old=policy.validate(saved);
  const resumed=await m.resumeConversation({conversationId:threadId,cwd:saved.cwd,workspaceRoots:[saved.cwd],model:existing?.latestModel??null,reasoningEffort:existing?.latestReasoningEffort??null,permissions:policy.nativePermissions(old,saved.cwd),collaborationMode:existing?.latestCollaborationMode??null},{readResumeInputs:async({model,cwd})=>m.settings.readSettings(model,cwd)});
  if(resumed.status==='not-ready'||!m.getConversation(threadId))throw Object.assign(Error('Native conversation could not be resumed; permissions were not changed'),{status:503});
  if((await m.readThread(threadId,{includeTurns:false})).thread?.status?.type==='active'||busy())throw Object.assign(Error('Thread became active or is awaiting approval; permissions were not changed'),{status:409});
  return m;
 }
 async function prepare(threadId){const state=policy.loadState(),saved=state.threads[threadId];if(!saved)throw Object.assign(Error('Thread was not created by this execution bridge'),{status:403});const p=policy.validate(saved),m=await idleConversation(threadId,saved);
  await m.updateThreadSettingsForNextTurn(threadId,{cwd:saved.cwd,...policy.nativePermissions(p,saved.cwd),permissions:null});return snapshot(threadId);
 }
 async function create(args){
  const p=policy.validate(args),state=policy.loadState();if(!/^[a-f0-9-]{36}$/i.test(args.requestId??''))throw Error('Stable bridge requestId is required');
  if(!args.cwd)fs.mkdirSync(path.join(root,'runtime/execution-workspaces',args.requestId),{recursive:true});
  const cwd=policy.canonicalDirectory(args.cwd??path.join(root,'runtime/execution-workspaces',args.requestId));if(policy.within(policy.directory(),cwd))throw Object.assign(Error('Workspace cannot contain the protected bridge settings directory'),{status:403});
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex'),old=state.requests[args.requestId];if(old){if(old.fingerprint!==fingerprint)throw Error('Native requestId reused with different arguments');if(old.result)return old.result;throw Error('Native creation outcome is unknown; inspect before retrying');}
  state.requests[args.requestId]={fingerprint,status:'creating'};policy.saveState(state);const m=await manager();
  const result=await m.startConversation({input:[],cwd,workspaceRoots:[cwd],workspaceKind:args.projectId?'project':'projectless',initialTitle:args.title??'Bridge execution task',mode:'default',threadSource:'user',threadStartKind:'default',permissionsConfig:policy.nativePermissions(p,cwd),config:policy.nativeConfig(p),collaborationMode:args.model?{mode:'default',settings:{model:args.model,reasoning_effort:args.effort??null,developer_instructions:null}}:undefined,projectAssignment:args.projectId?{projectKind:'local',projectId:args.projectId}:undefined},{readThreadCreationInputs:async()=>inputs(m)});
  if(result.status!=='created'||!result.conversationId)throw Error('Native GUI creation outcome unknown: '+JSON.stringify(result));const threadId=result.conversationId;
  state.threads[threadId]={...p,cwd,projectId:args.projectId,createdAt:new Date().toISOString()};state.requests[args.requestId].threadId=threadId;policy.saveState(state);managed.add(threadId);await observeManager();
  await m.updateThreadSettingsForNextTurn(threadId,{cwd,...policy.nativePermissions(p,cwd),permissions:null});if(args.title)await m.setThreadTitle(threadId,args.title);
  const out={threadId,hostId:'local',execution:await snapshot(threadId)};state.requests[args.requestId].result=out;state.requests[args.requestId].status='created';policy.saveState(state);return out;
 }
 async function setPermissions(threadId,input){
  if(!input||typeof input.sandboxMode!=='string'||Object.keys(input).some(key=>!['sandboxMode','approvalPolicy','writableRoots'].includes(key)))throw policy.fail('Explicit sandboxMode and permission fields only are required');
  let protectedIds=[];try{protectedIds=JSON.parse(fs.readFileSync(path.join(root,'runtime/router/protected-threads.json'),'utf8')).threadIds??[];}catch(e){if(e.code!=='ENOENT')throw e;}
  if(protectedIds.includes(threadId))throw Object.assign(Error('This desktop chat is protected; permissions were not changed'),{status:409});
  const saved=policy.loadState().threads[threadId];if(!saved)throw Object.assign(Error('Only bridge-managed Codex threads support permission updates'),{status:403});
  const p=policy.validate(input),m=await idleConversation(threadId,saved);
  const applied=await m.updateThreadSettingsForNextTurn(threadId,{cwd:saved.cwd,...policy.nativePermissions(p,saved.cwd),permissions:null});
  const selected=m.getConversation(threadId).latestThreadSettings,native=policy.nativePermissions(p,saved.cwd);
  if(applied===false||selected?.sandboxPolicy?.type!==native.sandboxPolicy.type||selected?.approvalPolicy!==p.approvalPolicy)throw Error('Native permission update was not confirmed; persisted policy was not changed');
  const state=policy.loadState();state.threads[threadId]={...state.threads[threadId],...p,permissionsUpdatedAt:new Date().toISOString()};policy.saveState(state);
  return {threadId,appliedTo:'next-turn',nextTurnSettings:p,nativeExecution:await snapshot(threadId)};
 }
 const server=net.createServer(socket=>{let data='',handled=false;socket.setTimeout(90000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',async chunk=>{if(handled)return;data+=chunk.toString('utf8');if(data.length>1024*1024)return socket.destroy();const index=data.indexOf('\n');if(index<0)return;handled=true;
  const reply=value=>{if(!socket.destroyed)socket.end(JSON.stringify(value)+'\n');};try{const r=JSON.parse(data.slice(0,index));if(r.token!==token)return reply({error:'Unauthorized',status:401});
   if(r.method==='status')return reply({pid:process.pid,binding:api.binding,desktopVersion:app.getVersion(),desktopPackageVersion:manifest.version,revision:api.revision,ready:!!await manager(),policyFile:policy.settingsFile()});
   guard?.check(r,{probe:r.method==='maintenance'});
   if(r.method==='maintenance'){const m=await manager(),loaded=await req(path.join(adapterRoot,'helper-binding.cjs')).loadedThreadIds(globalThis.__codexExecutionConnection);for(const id of loaded){const thread=(await m.readThread(id,{includeTurns:false})).thread;if(thread?.status?.type!=='idle'||m.getThreadExecutionState(id)?.inProgress||m.getConversation(id)?.requests?.length)return reply({authoritative:true,idle:false,binding:api.binding});}return reply({authoritative:true,idle:api.busy===0,binding:api.binding});}
   if(r.method==='read')return reply(await snapshot(r.threadId));if(r.method==='create'){api.busy++;try{const operation=creationTail.then(()=>create(r.args));creationTail=operation.catch(()=>{});return reply(await operation);}finally{api.busy--;}}
   if(['prepare','set_permissions'].includes(r.method)){api.busy++;try{const operation=creationTail.then(()=>r.method==='prepare'?prepare(r.threadId):setPermissions(r.threadId,r.policy));creationTail=operation.catch(()=>{});return reply(await operation);}finally{api.busy--;}}throw Error('Unsupported execution method');
  }catch(e){reply({error:e.message,status:e.status??500,code:e.code});}
 });});server.on('error',()=>{});server.listen('\\\\.\\pipe\\codex-gui-bridge-execution');
 api.server=server;globalThis.__codexExecutionBridge=api;return JSON.stringify({installed:true,pid:process.pid});
}
module.exports=install;
