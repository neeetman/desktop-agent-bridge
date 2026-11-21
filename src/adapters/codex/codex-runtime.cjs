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
module.exports={APP_SERVER_HOST,hostMismatch,connectionConstructor,managerConstructor,liveInstances,localConnection,localManager,desktopVersion,homeDirectory,reloadBlockReason};
