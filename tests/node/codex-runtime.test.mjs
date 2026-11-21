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
test('configured protected chats block global MCP reload independently of caller requests',()=>{
 assert.match(runtimeHelper.reloadBlockReason({threadIds:['protected-chat']}),/deferred/);
 assert.equal(runtimeHelper.reloadBlockReason({threadIds:[]}),null);
 assert.equal(runtimeHelper.reloadBlockReason(undefined),null);
});
