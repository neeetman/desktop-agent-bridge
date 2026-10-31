// Resolve constructors from the already running desktop runtime; never run an extracted bundle.
async function connectionConstructor(manifest,dependencies={}){
 const req=dependencies.require??process.mainModule.require.bind(process.mainModule);
 const app=dependencies.app??req('electron').app;
 if(!manifest.connectionModuleId){
  const mod=req(req('node:path').join(app.getAppPath(),manifest.connectionModule));
  const ctor=Object.values(mod).find(x=>typeof x==='function'&&typeof x.prototype?.sendAppServerRequest==='function');
  if(!ctor)throw Error('Native AppServerConnection constructor unavailable');return ctor;
 }
 const id=manifest.connectionModuleId;if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid validated webpack module ID');
 let runtime=globalThis.__codexBridgeWebpackRequire;
 if(!(typeof runtime==='function'&&runtime.m?.[id]&&typeof runtime.d==='function')){
  const session=new(req('node:inspector').Session)();session.connect();
  const post=(method,params)=>new Promise((resolve,reject)=>session.post(method,params,(error,value)=>error?reject(error):resolve(value)));
  try{
   const callbacks=[...app.eventNames().flatMap(event=>app.listeners(event)),...process.eventNames().flatMap(event=>process.listeners(event))].slice(0,256);
   outer:for(const callback of callbacks){
    globalThis.__codexBridgeRuntimeProbe=callback;
    const fn=await post('Runtime.evaluate',{expression:'globalThis.__codexBridgeRuntimeProbe'}),props=await post('Runtime.getProperties',{objectId:fn.result.objectId,ownProperties:false}),scopes=props.internalProperties?.find(x=>x.name==='[[Scopes]]');if(!scopes)continue;
    const list=await post('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
    for(const scope of list.result){
     if(!scope.value?.objectId||scope.value.description==='Global')continue;
     const entries=await post('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
     for(const entry of entries.result.filter(e=>e.value?.type==='function')){
      const found=await post('Runtime.callFunctionOn',{objectId:entry.value.objectId,functionDeclaration:'function(id){if(typeof this.m==="object"&&typeof this.d==="function"&&this.m[id]){globalThis.__codexBridgeWebpackRequire=this;return true;}return false;}',arguments:[{value:id}],returnByValue:true});
      if(found.result?.value)break outer;
     }
    }
   }
   runtime=globalThis.__codexBridgeWebpackRequire;
  }finally{delete globalThis.__codexBridgeRuntimeProbe;session.disconnect();}
 }
 if(!(typeof runtime==='function'&&runtime.m?.[id]))throw Error('Validated desktop webpack runtime unavailable');
 // This is the live connection module already used by the running desktop, not the on-disk chunk factory.
 const ctor=Object.values(runtime(id)).find(x=>typeof x==='function'&&typeof x.prototype?.sendAppServerRequest==='function');
 if(!ctor)throw Error('Validated desktop module no longer exports AppServerConnection');return ctor;
}
function reloadBlockReason(protection){return Array.isArray(protection?.threadIds)&&protection.threadIds.length?'Global MCP reload deferred: protected desktop chats are configured':null;}
module.exports={connectionConstructor,reloadBlockReason};
