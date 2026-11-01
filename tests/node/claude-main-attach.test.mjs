import {projectURL} from "../../src/lib/paths.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';

function fixture(url='https://claude.ai/epitaxy/local_test'){
  let accept;const calls=[];
  const api={getSessionList:async()=>{calls.push('read');return {sessions:[{title:'中文回执'}]};},sendMessage:async(...args)=>{calls.push(args);return {ok:true};}};
  const contents=Object.assign(new EventEmitter(),{id:2,isDestroyed:()=>false,getURL:()=>url,getType:()=> 'window',executeJavaScript:async code=>vm.runInNewContext(code,{window:{'claude.web':{LocalSessions:api}}})});
  const app=Object.assign(new EventEmitter(),{getVersion:()=> '4.29.0'});
  const modules={'node:worker_threads':{isMainThread:true},electron:{app,webContents:{getAllWebContents:()=>[contents]}},'node:fs':{readFileSync:()=>JSON.stringify({token:'test-token'})},'node:net':{createServer:handler=>{accept=handler;return {on(){},listen(){},close(){}};}}};
  const context={process:{type:'browser',pid:123,mainModule:{require:name=>modules[name]}},module:{exports:{}},setInterval:()=>({unref(){}}),clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(projectURL("claude-main-attach.cjs"),'utf8'),context);
  context.module.exports({connectionFile:'test',transport:'main-renderer-rpc',revision:'test'});
  return {calls,async request(input){const socket=Object.assign(new EventEmitter(),{setTimeout(){},end(value){this.output=value;},destroy(){this.destroyed=true;}});accept(socket);await socket.listeners('data')[0](Buffer.from(JSON.stringify(input)+'\n'));return socket.output?JSON.parse(socket.output):null;}};
}
test('Claude native renderer RPC authenticates and restricts methods before execution',async()=>{
  const f=fixture();
  assert.equal((await f.request({token:'wrong',method:'native'})).error,'Unauthorized');
  assert.match((await f.request({token:'test-token',method:'native',nativeMethod:'executeJavaScript',args:[],expiresAt:Date.now()+5000})).error,/Unsupported/);
  assert.match((await f.request({token:'test-token',method:'native',nativeMethod:'sendMessage',args:['id','prompt'],expiresAt:Date.now()-1})).error,/expired/);
  assert.deepEqual(f.calls,[]);
});
test('Claude RPC returns asynchronous native results without a control session or file writes',async()=>{
  const f=fixture();const result=await f.request({token:'test-token',method:'native',nativeMethod:'getSessionList',args:[],expiresAt:Date.now()+5000});
  assert.equal(result.result.sessions[0].title,'中文回执');assert.deepEqual(f.calls,['read']);
});
test('Claude RPC refuses unrelated web origins',async()=>{
  const f=fixture('https://example.com/epitaxy/local_test');
  const result=await f.request({token:'test-token',method:'native',nativeMethod:'getSessionList',args:[],expiresAt:Date.now()+5000});
  assert.match(result.error,/page unavailable/);assert.deepEqual(f.calls,[]);
});
