// Resolve constructors from the already running desktop runtime; never run an extracted bundle.
// A manifest with host "app-server-host" is evaluated in Codex's app server utility
// process (26.1117+), which owns the AppServerConnection and the conversation manager;
// otherwise the helper runs in the Electron main process.
const APP_SERVER_HOST='app-server-host';
function hostMismatch(manifest,proc=process){
 if(manifest?.host==null)return proc.type==='browser'?null:'not the desktop main process';
 if(manifest.host!==APP_SERVER_HOST)return 'unsupported helper host';
 const file=String(proc.mainModule?.filename??'').replace(/\\/g,'/');
 return proc.type==='utility'&&file.endsWith('/app-server-host.js')?null:'not the app server host process';
}
// Electron's app object exists only in the main process.
function electronApp(req,proc=process){return proc.type==='browser'?req('electron').app:null;}
function listenerSources(app){
 const sources=[process];if(app)sources.unshift(app);
 if(process.parentPort&&typeof process.parentPort.eventNames==='function')sources.push(process.parentPort);
 return sources.flatMap(source=>source.eventNames().flatMap(event=>source.listeners(event)));
}
function inspectorSession(req){
 const session=new(req('node:inspector').Session)();session.connect();
 const post=(method,params)=>new Promise((resolve,reject)=>session.post(method,params,(error,value)=>error?reject(error):resolve(value)));
 return {post,close:()=>session.disconnect()};
}
async function closureEntries(post,objectId){
 const props=await post('Runtime.getProperties',{objectId,ownProperties:false}),scopes=props.internalProperties?.find(x=>x.name==='[[Scopes]]');if(!scopes)return [];
 const list=await post('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true}),rows=[];
 for(const scope of list.result){if(!scope.value?.objectId||scope.value.description==='Global')continue;const entries=await post('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});rows.push(...entries.result);}
 return rows;
}
async function webpackRuntime(manifest,id,req,app){
 let runtime=globalThis.__codexBridgeWebpackRequire;
 if(typeof runtime==='function'&&runtime.m?.[id]&&typeof runtime.d==='function')return runtime;
 const {post,close}=inspectorSession(req);
 try{
  const callbacks=listenerSources(app).slice(0,256);
  outer:for(const callback of callbacks){
   globalThis.__codexBridgeRuntimeProbe=callback;
   const fn=await post('Runtime.evaluate',{expression:'globalThis.__codexBridgeRuntimeProbe'});
   for(const entry of (await closureEntries(post,fn.result.objectId)).filter(e=>e.value?.type==='function')){
    const found=await post('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(id){if(typeof this.m==="object"&&typeof this.d==="function"&&this.m[id]){globalThis.__codexBridgeWebpackRequire=this;return true;}return false;}',arguments:[{value:id}],returnByValue:true});
    if(found.result?.value)break outer;
   }
  }
  runtime=globalThis.__codexBridgeWebpackRequire;
 }finally{delete globalThis.__codexBridgeRuntimeProbe;close();}
 if(!(typeof runtime==='function'&&runtime.m?.[id]))throw Error('Validated desktop webpack runtime unavailable');
 return runtime;
}
async function connectionConstructor(manifest,dependencies={}){
 const req=dependencies.require??process.mainModule.require.bind(process.mainModule);
 const app=dependencies.app??electronApp(req);
 if(!manifest.connectionModuleId){
  if(!app)throw Error('Validated webpack module ID is required outside the main process');
  const mod=req(req('node:path').join(app.getAppPath(),manifest.connectionModule));
  const ctor=Object.values(mod).find(x=>typeof x==='function'&&typeof x.prototype?.sendAppServerRequest==='function');
  if(!ctor)throw Error('Native AppServerConnection constructor unavailable');return ctor;
 }
 const id=manifest.connectionModuleId;if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid validated webpack module ID');
 const runtime=await webpackRuntime(manifest,id,req,app);
 // This is the live connection module already used by the running desktop, not the on-disk chunk factory.
 const ctor=Object.values(runtime(id)).find(x=>typeof x==='function'&&typeof x.prototype?.sendAppServerRequest==='function');
 if(!ctor)throw Error('Validated desktop module no longer exports AppServerConnection');return ctor;
}
// The conversation manager class is not exported. Before 26.1117 it was reached through the
// closure of the connection's getStatsigEvaluations option; the app server host does not set
// that option, so the manager module's own exports are searched for a closure holding the class.
async function managerConstructor(manifest,connection,dependencies={}){
 const req=dependencies.require??process.mainModule.require.bind(process.mainModule);
 const name=manifest.managerClass;if(typeof name!=='string'||!name)throw Error('Validated manager class name is required');
 const {post,close}=inspectorSession(req),seeds=[];
 if(typeof connection?.options?.getStatsigEvaluations==='function')seeds.push(connection.options.getStatsigEvaluations);
 try{
  if(Number.isSafeInteger(manifest.managerModuleId)&&manifest.managerModuleId>0){
   const runtime=await webpackRuntime(manifest,manifest.managerModuleId,req,dependencies.app??electronApp(req)),exports=runtime(manifest.managerModuleId);
   for(const key of Object.keys(exports)){const d=Object.getOwnPropertyDescriptor(exports,key);if(typeof d?.get==='function')seeds.push(d.get);if(typeof d?.value==='function')seeds.push(d.value);}
  }
  for(const seed of seeds.slice(0,64)){
   globalThis.__codexBridgeManagerProbe=seed;
   const fn=await post('Runtime.evaluate',{expression:'globalThis.__codexBridgeManagerProbe'});
   const entry=(await closureEntries(post,fn.result.objectId)).find(e=>e.name===name&&e.value?.type==='function');
   if(!entry)continue;
   await post('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(){globalThis.__codexBridgeManagerClass=this;return true}',returnByValue:true});
   const ctor=globalThis.__codexBridgeManagerClass;delete globalThis.__codexBridgeManagerClass;
   if(typeof ctor==='function'&&typeof ctor.prototype?.getConversation==='function')return ctor;
  }
 }finally{delete globalThis.__codexBridgeManagerProbe;delete globalThis.__codexBridgeManagerClass;close();}
 throw Error('Native local conversation manager class unavailable');
}
// A class that its webpack module does not export, found through the closures of what it does export.
async function classFromModule(moduleId,className,accept,dependencies={}){
 const req=dependencies.require??process.mainModule.require.bind(process.mainModule);
 if(!Number.isSafeInteger(moduleId)||moduleId<=0||typeof className!=='string'||!className)throw Error('Validated module ID and class name are required');
 const runtime=await webpackRuntime({},moduleId,req,dependencies.app??electronApp(req)),exports=runtime(moduleId),seeds=[];
 for(const key of Object.keys(exports)){const d=Object.getOwnPropertyDescriptor(exports,key);if(typeof d?.get==='function')seeds.push(d.get);if(typeof d?.value==='function')seeds.push(d.value);}
 const {post,close}=inspectorSession(req);
 try{
  for(const seed of seeds.slice(0,64)){
   globalThis.__codexBridgeClassProbe=seed;
   const fn=await post('Runtime.evaluate',{expression:'globalThis.__codexBridgeClassProbe'});
   const entry=(await closureEntries(post,fn.result.objectId)).find(e=>e.name===className&&e.value?.type==='function');
   if(!entry)continue;
   await post('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(){globalThis.__codexBridgeClass=this;return true}',returnByValue:true});
   const ctor=globalThis.__codexBridgeClass;
   if(typeof ctor==='function'&&accept(ctor.prototype))return ctor;
  }
 }finally{delete globalThis.__codexBridgeClassProbe;delete globalThis.__codexBridgeClass;close();}
 throw Error('Validated desktop class '+className+' unavailable');
}
// Codex 26.1117+: the main process holds an RPC proxy of the app server connection, and the
// conversation manager lives in the app server host. Main reaches the manager through its
// manager registry, as Codex itself does: registry.getCurrent(hostId).resource.control.openClient().
async function rpcConnection(manifest,dependencies={}){
 const ctor=await classFromModule(manifest.connectionModuleId,manifest.connectionClass,p=>typeof p?.sendAppServerRequest==='function',dependencies);
 const rows=(await liveInstances(ctor,dependencies)).filter(x=>x.hostId==='local'&&typeof x.getConnectionState==='function'&&x.getConnectionState()==='connected');
 if(rows.length!==1)throw Error('Unique local app-server connection unavailable');
 return rows[0];
}
async function rpcManagerClient(manifest,dependencies={}){
 const ctor=await classFromModule(manifest.registryModuleId,manifest.registryClass,p=>typeof p?.getCurrent==='function'&&typeof p?.hasConnection==='function',dependencies);
 const controls=(await liveInstances(ctor,dependencies)).filter(x=>!x.disposed).map(x=>x.getCurrent('local')?.resource?.control).filter(x=>x&&typeof x.openClient==='function');
 if(controls.length!==1)throw Error('Unique local conversation manager unavailable');
 const client=await controls[0].openClient();
 if(!client)throw Error('Conversation manager client unavailable');
 return client;
}
function disposeClient(client){try{client?.[Symbol.dispose]?.();}catch{}}
// Inputs a desktop chat is created with. The renderer adds its own dynamic tools; a chat created
// from the main process has none, and the bridge reaches it through MCP instead.
function creationInputs(){return {hasDesktopRuntime:true,hasLocalRuntime:true,hasDeveloperInstructions:true,isBrowserRuntime:false,usesDesktopMcp:true,everydayWork:false,sidebarSectionToolsEnabled:true,readDynamicTools:async()=>({kind:'dynamic',tools:[]})};}
// One awaited manager API for both layouts. Creation and resume inputs are supplied here:
// from the in-process manager's settings before 26.1117, by the app server host itself after.
function legacyFacade(m){
 const inputs=async()=>({...creationInputs(),usesDesktopMcp:m.settings.usesDesktopMcp,readDynamicTools:m.settings.readDynamicTools});
 return {kind:'in-process',hostId:m.hostId,get disposed(){return !!m.disposed;},
  readThread:(id,options)=>m.readThread(id,options),getConversation:async id=>m.getConversation(id),getThreadExecutionState:async id=>m.getThreadExecutionState(id),
  startConversation:args=>m.startConversation(args,{readThreadCreationInputs:inputs}),
  resumeConversation:args=>m.resumeConversation(args,{readResumeInputs:async({model,cwd})=>m.settings.readSettings(model,cwd)}),
  updateThreadSettingsForNextTurn:(id,settings)=>m.updateThreadSettingsForNextTurn(id,settings),setThreadTitle:(id,title)=>m.setThreadTitle(id,title),
  getThreadProjectAssignment:async id=>m.getThreadProjectAssignment(id),
  observe:(onState,onApproval)=>[m.addConversationStateCallback(onState),m.addApprovalRequestListener(e=>onApproval(e.conversationId??e.threadId,m.getConversation(e.conversationId??e.threadId)))],
  dispose(){}};
}
// A failed call marks the client stale; the next request reopens it and never replays this one.
function rpcFacade(client){
 let stale=false;const call=fn=>async(...args)=>{try{return await fn(...args);}catch(error){stale=true;throw error;}};
 return {kind:'manager-rpc',hostId:'local',get disposed(){return stale;},
  readThread:call((id,options)=>client.readThread(id,options)),getConversation:call(id=>client.getConversation(id)),getThreadExecutionState:call(id=>client.getThreadExecutionState(id)),
  startConversation:call(args=>client.startConversation(args,{readThreadCreationInputs:async()=>creationInputs()})),
  resumeConversation:call(args=>client.resumeConversation(args)),
  updateThreadSettingsForNextTurn:call((id,settings)=>client.updateThreadSettingsForNextTurn(id,settings)),setThreadTitle:call((id,title)=>client.setThreadTitle(id,title)),
  // Project assignment lives in the host's workspace storage, which the client does not expose.
  getThreadProjectAssignment:async()=>null,
  observe:()=>[],
  dispose(){stale=true;disposeClient(client);}};
}
// The live local connection and manager facade for a manifest.
async function resolveConnection(manifest,dependencies={}){
 if(manifest.connectionClass)return rpcConnection(manifest,dependencies);
 const rows=localConnection(await liveInstances(await connectionConstructor(manifest,dependencies),dependencies));
 if(rows.length!==1)throw Error('Unique local app-server connection unavailable');
 return rows[0];
}
async function resolveManager(manifest,connection,dependencies={}){
 if(manifest.registryClass)return rpcFacade(await rpcManagerClient(manifest,dependencies));
 const rows=localManager(await liveInstances(await managerConstructor(manifest,connection,dependencies),dependencies));
 if(rows.length!==1)throw Error('Unique live conversation manager unavailable');
 return legacyFacade(rows[0]);
}
// Live instances of a constructor, through the inspector heap query.
async function liveInstances(ctor,dependencies={}){
 const req=dependencies.require??process.mainModule.require.bind(process.mainModule);
 const {post,close}=inspectorSession(req);
 try{
  globalThis.__codexBridgeInstancePrototype=ctor.prototype;
  const proto=await post('Runtime.evaluate',{expression:'globalThis.__codexBridgeInstancePrototype'}),objects=await post('Runtime.queryObjects',{prototypeObjectId:proto.result.objectId});
  await post('Runtime.callFunctionOn',{objectId:objects.objects.objectId,functionDeclaration:'function(){globalThis.__codexBridgeInstances=[...this];return true}',returnByValue:true});
  return globalThis.__codexBridgeInstances??[];
 }finally{delete globalThis.__codexBridgeInstancePrototype;delete globalThis.__codexBridgeInstances;close();}
}
function localConnection(rows){return rows.filter(x=>x.options?.hostId==='local'&&!x.disposed&&x.connectionState==='connected');}
function localManager(rows){return rows.filter(x=>x.hostId==='local'&&!x.disposed&&['getConversation','readThread','startConversation'].every(k=>typeof x[k]==='function'));}
// Desktop version for status replies: Electron's app in the main process, the manifest elsewhere.
function desktopVersion(manifest,req,proc=process){const app=electronApp(req,proc);return app?app.getVersion():manifest.version;}
function homeDirectory(req,proc=process){const app=electronApp(req,proc);return app?app.getPath('home'):req('node:os').homedir();}
function reloadBlockReason(protection){return Array.isArray(protection?.threadIds)&&protection.threadIds.length?'Global MCP reload deferred: protected desktop chats are configured':null;}
module.exports={APP_SERVER_HOST,hostMismatch,connectionConstructor,managerConstructor,classFromModule,rpcConnection,rpcManagerClient,disposeClient,creationInputs,legacyFacade,rpcFacade,resolveConnection,resolveManager,liveInstances,localConnection,localManager,desktopVersion,homeDirectory,reloadBlockReason};
