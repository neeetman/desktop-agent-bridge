import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../../src/core/bridge.mjs';
import {PeerRouter} from '../../src/mcp/peer-router.mjs';

test('a peer answer resumes the exact paused callback task ahead of old notifications, once across restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'peer-decision-resume-'));
 let sends=0,busy=false,uncertain=false,crashSnapshot;const sentThreads=[];
 const tools={callerThread:'controller',close(){},async call(name,args){
  if(name==='create_thread')return {threadId:'worker',hostId:'local'};
  if(name==='read_thread')return {thread:{status:{type:busy?'active':'idle'}},turns:[]};
  if(name==='send_message_to_thread'){sends++;sentThreads.push(args.threadId);if(uncertain)throw Error('native outcome unknown');return {threadId:args.threadId};}
  throw Error(name);
 }};
 let bridge=await startBridge({tools,stateDir:path.join(directory,'backend'),port:0,enableIpc:false,pollMs:1e9});
 const request=async(route,method='GET',body)=>{
  const response=await fetch(bridge.baseUrl+route,{method,headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error),{status:response.status,code:result.code});return result;
 };
 let router;
 const backendRequest=async(app,route,method,body)=>{
  if(app==='claude')return {settings:{},thread:{status:{type:'active'}}};
  if(route.endsWith('/respond'))crashSnapshot=JSON.stringify(router.state);
  return request(route,method,body);
 };
 const makeRouter=()=>{const r=new PeerRouter({directory:path.join(directory,'router'),backendRequest,pollMs:1e9});r.tick=async()=>{};return r;};
 router=makeRouter();const tick=()=>PeerRouter.prototype.tick.call(router);
 const worker={app:'codex',threadId:'worker'},supervisor={app:'claude',threadId:'supervisor'};
 try{
  const task=await request('/v1/tasks','POST',{prompt:'work'});
  const callback=await request('/v1/inbox','POST',{taskId:task.id,messageId:'callback',kind:'decision',question:'original question',options:['original A','original B']});
  const old=await router.send({from:supervisor,to:worker,text:'older queued work request',expectReply:true});
  assert.equal(router.state.jobs[old.id].status,'queued');assert.equal(sends,0);
  const peer=await router.requestDecision({from:worker,to:supervisor,question:`Escalating callback ${callback.decisionId}`,options:['A','B']});
  await router.answerDecision({from:supervisor,decisionId:peer.id,answer:'B',context:'chosen direction'});
  busy=true;await tick();assert.equal(sends,0);
  busy=false;await tick();assert.equal(sends,1);
  assert.equal(router.state.jobs[peer.messageId].skippedReason,'decision_already_answered');
  const answer=router.state.jobs[peer.answerMessageId];assert.equal(answer.status,'delivered');assert.equal(answer.resumeDecisionId,callback.decisionId);
  assert.equal(bridge.state.tasks[task.id].status,'resumed');
  const continuation=bridge.state.tasks[answer.taskId];assert.equal(continuation.resumesTaskId,task.id);assert.equal(continuation.callbackMode,'peer');assert.match(continuation.prompt,/chosen direction/);
  assert.equal(router.state.jobs[old.id].status,'queued');
  const laterCallback=await request('/v1/inbox','POST',{taskId:continuation.id,messageId:'later-callback',kind:'decision',question:'a later decision must remain pending',options:['later A','later B']});
  // Simulate a crash after native acceptance but before the router saves the result.
  router.close();fs.writeFileSync(path.join(directory,'router/state.json'),crashSnapshot);
  await bridge.close();bridge=await startBridge({tools,stateDir:path.join(directory,'backend'),port:0,enableIpc:false,pollMs:1e9});
  router=makeRouter();await tick();assert.equal(sends,1);assert.equal(router.state.jobs[peer.answerMessageId].taskId,answer.taskId);
  assert.equal(bridge.state.decisions[laterCallback.decisionId].status,'pending');
  await tick();assert.equal(sends,2);assert.equal(router.state.jobs[old.id].status,'completed');
  assert.equal(bridge.state.decisions[laterCallback.decisionId].status,'pending');
  await assert.rejects(request(`/v1/decisions/${callback.decisionId}/respond`,'POST',{answer:'B',peerDecisionId:'different-peer',context:'other'}),/different peer/);
  // Missing linkage must not resolve an unrelated pending callback decision.
  bridge.state.tasks[answer.taskId].status='completed';
  const second=await request('/v1/tasks','POST',{prompt:'second task',threadId:'other-worker'});
  const secondCallback=await request('/v1/inbox','POST',{taskId:second.id,messageId:'second-callback',kind:'decision',question:'other question',options:['C','D']});
  const unrelated={app:'codex',threadId:'other-worker'};
  const unlinked=await router.requestDecision({from:unrelated,to:supervisor,question:'no callback ID',options:['C','D']});
  await router.answerDecision({from:supervisor,decisionId:unlinked.id,answer:'C'});
  const before=sends;await tick();assert.equal(sends,before);assert.equal(router.state.jobs[unlinked.answerMessageId].lastErrorCode,'DECISION_LINK_REQUIRED');
  router.state.decisions[unlinked.id].context=`Callback ${secondCallback.decisionId}`;uncertain=true;
  await tick();assert.equal(router.state.jobs[unlinked.answerMessageId].status,'unknown');
  const attempts=sentThreads.filter(id=>id==='other-worker').length;
  router.close();router=makeRouter();await tick();await tick();assert.equal(sentThreads.filter(id=>id==='other-worker').length,attempts);
 }finally{router.close();await bridge.close();fs.rmSync(directory,{recursive:true,force:true});}
});
