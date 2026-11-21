import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import runtimeHelper from '../../src/adapters/codex/codex-runtime.cjs';
const require=createRequire(import.meta.url);
class Connection{sendAppServerRequest(){}}

test('legacy desktop module is resolved by exported connection behavior',async()=>{
 const dependencies={app:{getAppPath:()=>process.cwd()},require:id=>id.endsWith('validated.cjs')?{other:()=>{},connection:Connection}:require(id)};
 assert.equal(await runtimeHelper.connectionConstructor({connectionModule:'validated.cjs'},dependencies),Connection);
});
test('webpack resolution uses a live callback closure and requires only the validated connection module',async()=>{
 const calls=[],nativeRequire=id=>{calls.push(id);return {connection:Connection};};
 nativeRequire.m={99991:()=>{throw Error('The on-disk factory must never be executed');}};nativeRequire.d=()=>{};
 const app=new EventEmitter();app.on('second-instance',()=>nativeRequire(99991));
 try{
  assert.equal(await runtimeHelper.connectionConstructor({connectionModuleId:99991},{require,app}),Connection);
  assert.deepEqual(calls,[99991]);
  await assert.rejects(runtimeHelper.connectionConstructor({connectionModuleId:'99991'},{require,app}),/Invalid validated/);
  nativeRequire.m[99992]=()=>{};
  const wrong=id=>({noConnection:()=>{}});wrong.m={99992:()=>{}};wrong.d=()=>{};globalThis.__codexBridgeWebpackRequire=wrong;
  await assert.rejects(runtimeHelper.connectionConstructor({connectionModuleId:99992},{require,app}),/no longer exports/);
 }finally{delete globalThis.__codexBridgeWebpackRequire;}
});
test('helpers run only in the process their manifest names',()=>{
 const host='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\resources\\app.asar\\.vite\\build\\app-server-host.js';
 assert.equal(runtimeHelper.hostMismatch({},{type:'browser'}),null);
 assert.match(runtimeHelper.hostMismatch({},{type:'utility',mainModule:{filename:host}}),/main process/);
 assert.equal(runtimeHelper.hostMismatch({host:'app-server-host'},{type:'utility',mainModule:{filename:host}}),null);
 assert.match(runtimeHelper.hostMismatch({host:'app-server-host'},{type:'browser',mainModule:{filename:'main.js'}}),/app server host/);
 assert.match(runtimeHelper.hostMismatch({host:'app-server-host'},{type:'utility',mainModule:{filename:'C:\\app\\worker.js'}}),/app server host/);
 assert.match(runtimeHelper.hostMismatch({host:'renderer'},{type:'utility'}),/unsupported/);
});
test('in a utility process the webpack runtime is found through parentPort listeners',async()=>{
 const nativeRequire=()=>({connection:Connection});nativeRequire.m={77001:()=>{}};nativeRequire.d=()=>{};
 const port=new EventEmitter();port.on('message',()=>nativeRequire(77001));
 const previous=process.parentPort;process.parentPort=port;
 try{assert.equal(await runtimeHelper.connectionConstructor({connectionModuleId:77001},{require,app:null}),Connection);}
 finally{if(previous===undefined)delete process.parentPort;else process.parentPort=previous;delete globalThis.__codexBridgeWebpackRequire;}
});
test('an unexported manager class is found through the closure of its module exports',async()=>{
 class Base{addConversationStateCallback(){}}
 class Manager extends Base{getConversation(){} readThread(){} startConversation(){}}
 const live=new Manager();live.hostId='local';const exported=()=>live instanceof Manager;
 const nativeRequire=id=>id===13994?{gX:exported}:{connection:Connection};nativeRequire.m={13994:()=>{},19229:()=>{}};nativeRequire.d=()=>{};
 globalThis.__codexBridgeWebpackRequire=nativeRequire;
 try{
  const ctor=await runtimeHelper.managerConstructor({managerClass:'Manager',managerModuleId:13994},{options:{hostId:'local'}},{require,app:null});
  assert.equal(ctor,Manager);
  const rows=runtimeHelper.localManager(await runtimeHelper.liveInstances(ctor,{require}));
  assert.deepEqual(rows,[live]);
  await assert.rejects(runtimeHelper.managerConstructor({managerClass:'Missing',managerModuleId:13994},{},{require,app:null}),/class unavailable/);
 }finally{delete globalThis.__codexBridgeWebpackRequire;}
});
test('26.1117: main reaches the host manager through its registry and the connection through its proxy',async()=>{
 class Proxy{constructor(id,state){this.id=id;this.state=state;}get hostId(){return this.id;}getConnectionState=()=>this.state;async sendAppServerRequest(){}}
 class Registry{constructor(control){this.control=control;this.disposed=false;}hasConnection(){return true;}getCurrent(id){return id==='local'?{resource:{control:this.control}}:null;}}
 const calls=[],client={readThread:async id=>({thread:{id}}),getConversation:async()=>({latestModel:'m'}),getThreadExecutionState:async()=>({inProgress:false}),
  startConversation:async(args,options)=>{calls.push(['start',args,await options.readThreadCreationInputs()]);return {status:'created',conversationId:'new'};},
  resumeConversation:async(args,options)=>{calls.push(['resume',args,options]);return {status:'ready'};},updateThreadSettingsForNextTurn:async()=>true,setThreadTitle:async()=>{},
  [Symbol.dispose](){calls.push(['dispose']);}};
 const live=[new Proxy('local','connected'),new Proxy('remote','connected'),new Proxy('local','disconnected')];
 const registry=new Registry({openClient:async()=>client});
 const exported=()=>[Proxy,Registry,live,registry];
 const nativeRequire=()=>({gX:exported});nativeRequire.m={89694:()=>{}};nativeRequire.d=()=>{};globalThis.__codexBridgeWebpackRequire=nativeRequire;
 const manifest={connectionModuleId:89694,connectionClass:'Proxy',registryModuleId:89694,registryClass:'Registry'};
 try{
  const connection=await runtimeHelper.resolveConnection(manifest,{require,app:null});
  assert.equal(connection,live[0]);
  const manager=await runtimeHelper.resolveManager(manifest,connection,{require,app:null});
  assert.equal(manager.kind,'manager-rpc');
  assert.deepEqual(await manager.readThread('t',{includeTurns:false}),{thread:{id:'t'}});
  assert.equal((await manager.getConversation('t')).latestModel,'m');
  assert.equal(await manager.getThreadProjectAssignment('t'),null);
  assert.deepEqual(manager.observe(),[]);
  await manager.startConversation({cwd:'c'});
  const inputs=calls[0][2];assert.equal(inputs.hasDesktopRuntime,true);assert.deepEqual(await inputs.readDynamicTools(),{kind:'dynamic',tools:[]});
  await manager.resumeConversation({conversationId:'t'});assert.equal(calls[1][2],undefined,'the host supplies its own resume inputs');
  assert.equal(manager.disposed,false);
  client.getThreadExecutionState=async()=>{throw Error('client closed');};
  await assert.rejects(manager.getThreadExecutionState('t'),/client closed/);
  assert.equal(manager.disposed,true,'a failed RPC marks the client stale so the next request reopens it');
  manager.dispose();assert.deepEqual(calls.at(-1),['dispose']);
  live[0].state='disconnected';
  await assert.rejects(runtimeHelper.resolveConnection(manifest,{require,app:null}),/Unique local app-server connection/);
  registry.disposed=true;
  await assert.rejects(runtimeHelper.resolveManager(manifest,null,{require,app:null}),/Unique local conversation manager/);
 }finally{delete globalThis.__codexBridgeWebpackRequire;}
});
test('the in-process facade supplies creation and resume inputs from the manager settings',async()=>{
 const seen=[],raw={hostId:'local',settings:{usesDesktopMcp:true,readDynamicTools:'tools',readSettings:async(model,cwd)=>({model,cwd})},
  getConversation:id=>({id}),getThreadExecutionState:()=>({inProgress:true}),startConversation:async(args,options)=>{seen.push(await options.readThreadCreationInputs());return {status:'created'};},
  resumeConversation:async(args,options)=>{seen.push(await options.readResumeInputs({model:'m',cwd:'c'}));return {status:'ready'};},
  addConversationStateCallback:fn=>()=>fn,addApprovalRequestListener:fn=>()=>fn};
 const m=runtimeHelper.legacyFacade(raw);
 assert.equal(m.kind,'in-process');assert.deepEqual(await m.getConversation('x'),{id:'x'});assert.equal((await m.getThreadExecutionState('x')).inProgress,true);
 await m.startConversation({});await m.resumeConversation({});
 assert.equal(seen[0].readDynamicTools,'tools');assert.equal(seen[0].usesDesktopMcp,true);assert.deepEqual(seen[1],{model:'m',cwd:'c'});
 assert.equal(m.observe(()=>{},()=>{}).length,2);
});
test('configured protected chats block global MCP reload independently of caller requests',()=>{
 assert.match(runtimeHelper.reloadBlockReason({threadIds:['protected-chat']}),/deferred/);
 assert.equal(runtimeHelper.reloadBlockReason({threadIds:[]}),null);
 assert.equal(runtimeHelper.reloadBlockReason(undefined),null);
});
