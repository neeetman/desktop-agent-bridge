import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PeerRouter,startRouter} from '../../src/mcp/peer-router.mjs';
import {creationOrigin} from '../../src/core/contracts.mjs';
import {Signals} from '../../src/core/signals.mjs';
import {startBridge} from '../../src/core/bridge.mjs';
import {CallbackForwarder} from '../../src/mcp/callback-forwarder.mjs';

const origin={app:'claude',threadId:'dispatcher'},worker={app:'codex',threadId:'worker'};
test('callback origin is bound to the exact creation header and durable idempotency key',()=>{
 const header={from:'claude:dispatcher',kind:'task_creation',requestId:'create-1'};
 const prompt=`[bridge ${JSON.stringify(header)}]\nTask`;
 assert.deepEqual(creationOrigin(prompt,'mcp-create:claude:dispatcher:create-1'),origin);
 assert.equal(creationOrigin(prompt,'mcp-create:claude:other:create-1'),null);
 assert.equal(creationOrigin(prompt,'another-controller'),null);
 assert.equal(creationOrigin('Task\n'+prompt,'mcp-create:claude:dispatcher:create-1'),null);
});

test('callback receipt records locally and cannot override the creating peer',()=>{
 const state={tasks:{t:{id:'t',threadId:'worker',peerOrigin:origin,taskVersion:'1'}},watches:{},idempotency:{}};let event;
 const signals=new Signals({state,save(){},emit(type,data){event={id:1,type,...data};return event;}});
 const result=signals.receive({taskId:'t',messageId:'report',text:'HUD finding',kind:'finding',peerOrigin:{app:'claude',threadId:'wrong'}},null,true);
 assert.equal(result.delivery,'recorded_locally');assert.deepEqual(event.peerOrigin,origin);assert.equal(event.taskVersion,'1');
});

test('HTTP task callbacks carry their creation origin, including legacy state recovery',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'callback-http-'));
 const tools={callerThread:'test',close(){},async call(name){return name==='create_thread'?{threadId:'worker',hostId:'local'}:{thread:{status:{type:'idle'}},turns:[]};}};
 let bridge=await startBridge({tools,stateDir:directory,port:0,pollMs:1e9,enableIpc:false});
 try{
  const prompt=`[bridge ${JSON.stringify({from:'claude:dispatcher',kind:'task_creation',requestId:'create-1'})}]\nTask`;
  const response=await fetch(bridge.baseUrl+'/v1/tasks',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json','Idempotency-Key':'mcp-create:claude:dispatcher:create-1'},body:JSON.stringify({prompt,taskVersion:'1'})});
  assert.equal(response.status,202);const task=await response.json();assert.deepEqual(task.peerOrigin,origin);
  const callback=JSON.parse(fs.readFileSync(task.taskCallback.credentialsFile));
  const report=await fetch(callback.url,{method:'POST',headers:{Authorization:`Bearer ${callback.token}`,'Content-Type':'application/json'},body:JSON.stringify({taskId:task.id,messageId:'report',text:'HUD report',kind:'finding'})});
  assert.equal((await report.json()).delivery,'recorded_locally');
  const events=(await (await fetch(bridge.baseUrl+'/v1/events',{headers:{Authorization:`Bearer ${bridge.token}`}})).json()).events;
  assert.deepEqual(events.find(e=>e.type==='session.outbound').peerOrigin,origin);
  await bridge.close();bridge=null;
  const state=JSON.parse(fs.readFileSync(path.join(directory,'state.json')));delete state.tasks[task.id].peerOrigin;fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify(state));
  bridge=await startBridge({tools,stateDir:directory,port:0,pollMs:1e9,enableIpc:false});assert.deepEqual(bridge.state.tasks[task.id].peerOrigin,origin);
 }finally{if(bridge)await bridge.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('a first-poll enqueue failure preserves a new callback for retry',async()=>{
 let failing=true,queued=0;const event={id:2,type:'session.outbound',time:new Date(Date.now()+1000).toISOString(),threadId:'worker',peerOrigin:origin,text:'new report',kind:'finding'};
 const router={state:{},save(){},backendRequest:async()=>({events:[{id:1,type:'session.outbound',time:'2020-01-01'},event],cursor:2}),send:async()=>{if(failing)throw Error('offline');queued++;}};
 const forwarder=new CallbackForwarder(router);await assert.rejects(forwarder.poll('codex'),/offline/);assert.equal(router.state.callbackCursors.codex,1);
 failing=false;await forwarder.poll('codex');assert.equal(queued,1);assert.equal(router.state.callbackCursors.codex,2);
});

test('callback forwarding queues once across a cursor-save crash, skips old history and links decisions',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'callback-forward-'));let events=[];
 const request=async(app,route)=>route.startsWith('/v1/events')?{events,cursor:events.at(-1)?.id??0}:route.startsWith('/v1/tasks/')?{peerOrigin:origin,taskVersion:'1'}:{thread:{status:{type:'active'}}};
 const router=new PeerRouter({directory,backendRequest:request,pollMs:1e9});router.tick=async()=>{};
 try{
  events=[{id:1,type:'session.outbound',time:'2020-01-01',threadId:'worker',peerOrigin:origin,text:'old',kind:'finding'}];
  await router.callbackForwarder.poll('codex');assert.equal(Object.keys(router.state.messages).length,0);
  events.push({id:2,type:'session.outbound',time:new Date().toISOString(),threadId:'worker',peerOrigin:origin,taskVersion:'1',text:'HUD finding',kind:'finding'});
  await router.callbackForwarder.poll('codex');assert.equal(Object.keys(router.state.messages).length,1);
  const message=Object.values(router.state.messages)[0];assert.deepEqual(message.from,worker);assert.deepEqual(message.to,origin);assert.equal(message.expectReply,true);
  router.state.callbackCursors.codex=1;router.save();
  const restored=new PeerRouter({directory,backendRequest:request,pollMs:1e9});restored.tick=async()=>{};
  try{await restored.callbackForwarder.poll('codex');assert.equal(Object.keys(restored.state.messages).length,1);}finally{restored.close();}
  router.state.callbackCursors.codex=2;
  events.push({id:3,type:'decision.requested',threadId:'worker',peerOrigin:origin,decisionId:'callback-decision',question:'Choose',options:['A','B']});
  await router.callbackForwarder.poll('codex');const decision=Object.values(router.state.decisions)[0];assert.match(decision.context,/callback-decision/);assert.deepEqual(decision.to,origin);
  events.push({id:4,type:'session.outbound',threadId:'worker',taskId:'legacy',text:'selected pending report',kind:'finding'});
  router.state.callbackReplays.codex=[4];await router.callbackForwarder.poll('codex');
  assert.deepEqual(router.state.callbackReplays.codex,[]);assert.equal(Object.values(router.state.messages).filter(m=>m.text==='selected pending report').length,1);
 }finally{router.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('duplicate router startup cannot overwrite live routing state or credentials',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'callback-owner-'));
 const live=await startRouter({directory,port:0,backendRequest:async()=>({events:[],cursor:0})});
 try{const before=fs.readFileSync(path.join(directory,'state.json')),credentials=fs.readFileSync(path.join(directory,'connection.json'));await assert.rejects(startRouter({directory,port:live.server.address().port}),{code:'EADDRINUSE'});assert.deepEqual(fs.readFileSync(path.join(directory,'state.json')),before);assert.deepEqual(fs.readFileSync(path.join(directory,'connection.json')),credentials);}finally{await live.close();fs.rmSync(directory,{recursive:true,force:true});}
});
