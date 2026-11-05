import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../../src/core/bridge.mjs';
import {coalesceInventory} from '../../src/compat/compatibility.mjs';

test('concurrent inventory reads share only the in-flight query; failures and completed snapshots are not cached',async()=>{
 let count=0,finish;
 const read=coalesceInventory(()=>{count++;return new Promise((resolve,reject)=>{finish={resolve,reject};});});
 const a=read(),b=read();await Promise.resolve();assert.equal(count,1);finish.resolve({processes:[]});assert.equal(await a,await b);
 const c=read(),d=read();await Promise.resolve();assert.equal(count,2);finish.reject(Error('inventory unavailable'));await assert.rejects(c,/inventory unavailable/);await assert.rejects(d,/inventory unavailable/);
 const e=read();await Promise.resolve();assert.equal(count,3);finish.resolve({processes:['new generation']});assert.deepEqual((await e).processes,['new generation']);
});

test('peer notifications reach an idle paused chat without answering its decision or completing its parent task',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paused-notification-'));let sends=0,turns=[{id:'original',status:'completed',items:[]}];
 const tools={callerThread:'controller',close(){},async call(name){
  if(name==='create_thread')return {threadId:'worker'};
  if(name==='read_thread')return {thread:{status:{type:turns[0]?.status==='inProgress'?'active':'idle'}},turns};
  if(name==='send_message_to_thread'){sends++;turns=[{id:'notice',status:'inProgress',items:[]},...turns];return {threadId:'worker'};}
  throw Error(name);
 }};
 const bridge=await startBridge({tools,stateDir:dir,port:0,pollMs:10,enableIpc:false});
 const request=async(route,body,key)=>{const r=await fetch(bridge.baseUrl+route,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  const parent=(await request('/v1/tasks',{prompt:'original task'})).data;bridge.state.tasks[parent.id].turnId='original';
  const decision=(await request('/v1/inbox',{taskId:parent.id,messageId:'question',kind:'decision',question:'choose?',options:['A','B']})).data;
  assert.equal((await request('/v1/threads/worker/messages',{prompt:'ordinary task'})).status,409);
  const input={prompt:'information, not an answer',callbackMode:'peer',peerNotification:true};
  const notice=await request('/v1/threads/worker/messages',input,'notice');assert.equal(notice.status,202);assert.equal(notice.data.pausedTaskId,parent.id);assert.equal(notice.data.resumesTaskId,undefined);
  assert.equal((await request('/v1/threads/worker/messages',input,'notice')).data.id,notice.data.id);assert.equal(sends,1);
  assert.equal(notice.data.completionEvidence,'native-input-accepted');
  assert.equal(notice.data.consumptionConfirmed,false);
  assert.equal((await request('/v1/threads/worker/messages',{...input,prompt:'another notice'},'other')).status,202);
  assert.equal(sends,2);
  turns[0].status='completed';
  for(let i=0;i<50&&bridge.state.tasks[notice.data.id].status!=='completed';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(bridge.state.tasks[notice.data.id].status,'completed');assert.equal(bridge.state.tasks[parent.id].status,'awaiting_decision');assert.equal(bridge.state.tasks[parent.id].pendingDecisionId,decision.decisionId);assert.equal(bridge.state.decisions[decision.decisionId].status,'pending');assert.equal(bridge.state.decisions[decision.decisionId].answer,undefined);
 }finally{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('notification enters a running bridge task without a native read or a new tracked turn',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'running-notification-'));let reads=0,sends=0;
 const tools={callerThread:'controller',close(){},async call(name){
  if(name==='create_thread')return {threadId:'worker'};
  if(name==='read_thread'){reads++;throw Error('read contract unavailable');}
  throw Error(name);
 },async sendNotification(args){sends++;assert.equal(args.prompt.trim(),'lease ready');return {threadId:'worker'};}};
 const bridge=await startBridge({tools,stateDir:dir,port:0,pollMs:1e9,enableIpc:false});
 const request=async(route,body,key)=>{const r=await fetch(bridge.baseUrl+route,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  const parent=(await request('/v1/tasks',{prompt:'original'},'parent')).data;
  const body={prompt:'lease ready',callbackMode:'peer',peerNotification:true};
  const notice=await request('/v1/threads/worker/messages',body,'notice');
  assert.equal(notice.status,202);assert.equal(reads,0);assert.equal(sends,1);
  assert.equal(notice.data.completionEvidence,'native-input-accepted');
  assert.equal(bridge.state.tasks[parent.id].status,'running');
  assert.equal((await request('/v1/threads/worker/messages',body,'notice')).data.id,notice.data.id);
  assert.equal(sends,1);assert.equal(notice.data.turnId,undefined);
  const changed=await request('/v1/threads/worker/messages',{...body,model:'another-model'},'changed');
  assert.equal(changed.status,400);assert.equal(sends,1);
 }finally{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});}
});
