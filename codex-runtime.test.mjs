import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import runtimeHelper from './codex-runtime.cjs';
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
test('configured protected chats block global MCP reload independently of caller requests',()=>{
 assert.match(runtimeHelper.reloadBlockReason({threadIds:['protected-chat']}),/deferred/);
 assert.equal(runtimeHelper.reloadBlockReason({threadIds:[]}),null);
 assert.equal(runtimeHelper.reloadBlockReason(undefined),null);
});
