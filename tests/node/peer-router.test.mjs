import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerRouter } from '../../src/mcp/peer-router.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-router-'));
  const sends = []; let busy = false, unknown = false,taskStatus='completed',nativeTurn=null;
  const backendRequest = async (app, route, method, body, key) => {
    if (route.endsWith('/settings')) return { settings: {} };
    if (method === 'POST') { sends.push({ app, route, body, key }); if (unknown) throw Object.assign(new Error('timeout'), { status: 502 }); return { id: `task-${sends.length}`, status: 'running' }; }
    if (route.startsWith('/v1/tasks/')) return { status: taskStatus, result: 'PEER_ACK',turnId:nativeTurn };
    return { thread: { status: { type: busy ? 'active' : 'idle' } },turns:nativeTurn?[{id:nativeTurn,status:'inProgress'}]:[] };
  };
  let healthNow=Date.parse('2026-11-01T00:00:00Z');
  const router = new PeerRouter({ directory, backendRequest, pollMs: 1e9, healthOptions:{now:()=>healthNow} });
  const tick = router.tick.bind(router); router.tick = async () => {};
  return { router, tick, sends, backendRequest, directory, advanceHealth(){healthNow+=30000;}, setBusy(value) { busy = value; }, setUnknown(value) { unknown = value; },setTask(value){taskStatus=value;},setTurn(value){nativeTurn=value;}, close() { router.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const from = { app: 'codex', threadId: 'c' }, to = { app: 'claude', threadId: 'a' };

test('update preflight blocks queued delivery without turning a known-unsent request into unknown',async()=>{
 const f=fixture();try{f.setTask('running');const message=await f.router.send({from,to,text:'defer update',messageId:'update'});let blocked=true;
 f.router.backendRequest=async(app,route,method,...rest)=>{if(method==='POST'&&blocked)throw Object.assign(Error('unsupported'),{status:503,code:'BUILD_UNSUPPORTED',dispatchNotStarted:true});return f.backendRequest(app,route,method,...rest);};
 await f.tick();assert.equal(f.router.state.jobs[message.id].status,'queued');assert.equal(f.router.state.jobs[message.id].blockedByUpdate,'BUILD_UNSUPPORTED');assert.equal(f.sends.length,0);
 blocked=false;await f.tick();assert.equal(f.sends.length,1);assert.equal(f.router.state.jobs[message.id].status,'delivered');
 }finally{f.close();}
});
test('decision answers persist while the original sender is updating and are dispatched after recovery',async()=>{
 const f=fixture();try{f.setTask('running');const decision=await f.router.requestDecision({from,to,question:'choose',options:['A','B']});
 f.router.backendRequest=async(app,route,...rest)=>{if(app==='codex')throw Object.assign(Error('updating'),{status:503,code:'BUILD_UNSUPPORTED',dispatchNotStarted:true});return f.backendRequest(app,route,...rest);};
 const answer=await f.router.answerDecision({from:to,decisionId:decision.id,answer:'A'});assert.equal(answer.status,'answered');assert.equal(f.router.state.jobs[answer.answerMessageId].status,'queued');await f.tick();assert.equal(f.router.state.jobs[answer.answerMessageId].status,'queued');
 f.router.backendRequest=f.backendRequest;await f.tick();assert.equal(f.router.state.jobs[answer.answerMessageId].status,'delivered');assert.equal((await f.router.answerDecision({from:to,decisionId:decision.id,answer:'A'})).answerMessageId,answer.answerMessageId);
 }finally{f.close();}
});
test('peer request automatically returns one final reply, queues while busy, and cannot form a reply loop', async () => {
  const f = fixture(); try {
    f.setTask('running');
    const message = await f.router.send({ from, to, text: 'ping', messageId: 'm' });
    f.setBusy(true); await f.tick(); assert.equal(f.sends.length, 0);
    f.setBusy(false); await f.tick();f.setBusy(true);f.setTurn('delivery-turn');await f.router.acknowledge({from:to,messageId:message.id});f.setBusy(false);f.setTask('completed');await f.tick();await f.tick();
    assert.equal(f.sends.length, 2);
    assert.equal(f.router.state.messages[message.id].status, 'replied');
    const inbox = f.router.receive(from); assert.equal(inbox.messages[0].text, 'PEER_ACK'); assert.equal(inbox.messages[0].expectReply, false);
    assert.equal(f.router.receive(from, inbox.cursor).messages.length, 0);
  } finally { f.close(); }
});
test('a completed but unacknowledged or different native turn is never auto-forwarded as the answer',async()=>{
  const f=fixture();try{
    const m=await f.router.send({from,to,text:'queued task'});await f.tick();await f.tick();
    assert.equal(m.status,'awaiting_ack');assert.equal(f.router.receive(from).messages.length,0);
    await f.router.reply({from:to,messageId:m.id,text:'explicitly reviewed answer'});assert.equal(f.router.receive(from).messages.length,1);
  }finally{f.close();}
});
test('decision validates recipient/options and persists an answer for the original sender', async () => {
  const f = fixture(); try {
    const decision = await f.router.requestDecision({ from, to, question: 'choose', options: ['A', 'B'], messageId: 'd' });
    await assert.rejects(f.router.answerDecision({ from, decisionId: decision.id, answer: 'A' }), /designated/);
    await assert.rejects(f.router.answerDecision({ from: to, decisionId: decision.id, answer: 'C' }), /offered/);
    await f.router.answerDecision({ from: to, decisionId: decision.id, answer: 'A' });
    await f.router.answerDecision({ from: to, decisionId: decision.id, answer: 'A' });
    assert.equal(f.router.receive(from).messages.length, 1);
    assert.equal(f.router.receive(from).messages[0].kind, 'decision_answer');
    assert.equal(f.router.state.decisions[decision.id].answer, 'A');
  } finally { f.close(); }
});
test('stable message IDs deduplicate and uncertain native mutations are never replayed', async () => {
  const f = fixture(); try {
    const first = await f.router.send({ from, to, text: 'ping', messageId: 'm' });
    const duplicate = await f.router.send({ to, from, messageId: 'm', text: 'ping' }); assert.equal(first.id, duplicate.id);
    await assert.rejects(f.router.send({ from, to, text: 'different', messageId: 'm' }), /reused/);
    f.setUnknown(true); await f.tick(); await f.tick(); assert.equal(f.sends.length, 1); assert.equal(f.router.state.jobs[first.id].status, 'unknown');
    const restored = new PeerRouter({ directory: f.directory, backendRequest: f.backendRequest, pollMs: 1e9 });
    try { await restored.tick(); assert.equal(f.sends.length, 1); } finally { restored.close(); }
  } finally { f.close(); }
});

test('DeepSeek participates in routing and app identity separates identical thread IDs', async () => {
  const f=fixture();try{
    const codex={app:'codex',threadId:'same-id'},deepseek={app:'deepseek',threadId:'same-id'};
    const message=await f.router.send({from:codex,to:deepseek,text:'ping',messageId:'m'});
    await f.router.reply({from:deepseek,messageId:message.id,text:'deepseek ack'});
    assert.equal(f.router.receive(codex).messages[0].from.app,'deepseek');
    assert.equal(f.router.receive(deepseek).messages[0].from.app,'codex');
    const decision=await f.router.requestDecision({from:deepseek,to:codex,question:'choose',options:['A','B']});
    await f.router.answerDecision({from:codex,decisionId:decision.id,answer:'A'});
    assert.equal(f.router.receive(deepseek).messages.at(-1).kind,'decision_answer');
  }finally{f.close();}
});
test('delivery and a candidate native turn never claim consumption; only the addressed recipient can ack',async()=>{
  const f=fixture();try{
    f.setTask('running');const m=await f.router.send({from,to,text:'v2 task',taskVersion:'spec.md@sha256:v2'});await f.tick();
    assert.equal(m.status,'delivered');assert.equal(m.consumption.status,'unconfirmed');
    f.setTurn('turn-A');await f.tick();assert.equal(m.observedNativeTurnId,'turn-A');assert.equal(m.consumption.status,'unconfirmed');
    await assert.rejects(f.router.acknowledge({from,messageId:m.id}),/recipient/);
    f.setBusy(true);const ack=await f.router.acknowledge({from:to,messageId:m.id});
    assert.equal(ack.consumption.turnId,'turn-A');assert.deepEqual(ack.receipt.consumedMessageIds,[m.id]);assert.equal(m.status,'consumed');
  }finally{f.close();}
});
test('explicit reply racing final completion produces one reply, with version and consumption receipt',async()=>{
  const f=fixture();try{
    f.setTask('running');const m=await f.router.send({from,to,text:'task',taskVersion:'spec@v2'});await f.tick();f.setTask('completed');
    await Promise.all([f.router.reply({from:to,messageId:m.id,text:'explicit'}),f.tick()]);await f.tick();
    const replies=f.router.receive(from).messages;assert.equal(replies.length,1);assert.equal(replies[0].text,'explicit');assert.equal(replies[0].taskVersion,'spec@v2');assert.deepEqual(replies[0].receipt.consumedMessageIds,[m.id]);
  }finally{f.close();}
});
test('same acknowledged turn explicit send suppresses automatic final forwarding, other turns do not',async()=>{
  for(const sameTurn of [true,false]){
    const f=fixture();try{
      f.setTask('running');const m=await f.router.send({from,to,text:'task'});await f.tick();
      f.setBusy(true);f.setTurn('turn-A');await f.router.acknowledge({from:to,messageId:m.id});f.setTurn(sameTurn?'turn-A':'turn-B');
      const outbound=await f.router.send({from:to,to:from,text:'explicit send',expectReply:false});
      assert.equal(m.autoReplySuppressedBy,sameTurn?outbound.id:undefined);
      f.setBusy(false);f.setTask('completed');await f.tick();
      assert.equal(Boolean(m.replyMessageId),false);
      assert.equal(m.status,sameTurn?'completed':'awaiting_ack');
    }finally{f.close();}
  }
});
test('notifications reject replies, retain source/version at the start and share a fixed guide',async()=>{
  const f=fixture();try{
    const m=await f.router.send({from,to,text:'notice',expectReply:false,taskVersion:'spec@v3'});
    const prompt=f.router.prompt(m);assert.ok(prompt.startsWith('[bridge '));assert.ok(prompt.includes('"expectReply":false'));assert.ok(prompt.includes('"taskVersion":"spec@v3"'));
    assert.ok(fs.existsSync(path.join(f.directory,'peer-guide-v2.md')));assert.equal(fs.existsSync(path.join(f.directory,`message-${m.id}.md`)),false);
    await assert.rejects(f.router.reply({from:to,messageId:m.id,text:'loop'}),/expectReply=false/);await f.tick();await f.tick();assert.equal(f.router.receive(from).messages.length,0);
  }finally{f.close();}
});
test('health returns native probe failures with a previous success and repair hint',async()=>{
  const f=fixture();try{
    const first=await f.router.health('codex');assert.equal(first.results[0].ok,true);
    f.router.backendRequest=async()=>{throw Error('missing desktop pipe');};
    f.advanceHealth();const second=await f.router.health('codex');assert.equal(second.results[0].ok,false);assert.equal(second.results[0].lastSuccessAt,first.results[0].lastSuccessAt);assert.match(second.results[0].repair,/Transient/);assert.equal(second.results[0].failedStep,'service_http');
  }finally{f.close();}
});
test('health subscriptions notify once per transition, persist baseline, and skip protected chats',async()=>{
  const f=fixture();try{
    f.router.state.healthSubscribers={one:{who:from},protected:{who:{app:'codex',threadId:'protected'}}};
    fs.writeFileSync(path.join(f.directory,'protected-threads.json'),JSON.stringify({threadIds:['protected']}));
    await f.router.health('codex');f.router.backendRequest=async()=>{throw Error('offline');};
    for(let i=0;i<3;i++){f.advanceHealth();await f.router.health('codex');}await f.router.health('codex');
    assert.equal(f.router.receive(from).messages.length,1);assert.equal(f.router.receive(from).messages[0].expectReply,false);
    assert.equal(f.router.receive({app:'codex',threadId:'protected'}).messages.length,0);
    f.router.backendRequest=f.backendRequest;f.advanceHealth();await f.router.health('codex');assert.equal(f.router.receive(from).messages.length,2);
    const restored=new PeerRouter({directory:f.directory,backendRequest:f.backendRequest,pollMs:1e9});
    try{await restored.health('codex');assert.equal(restored.receive(from).messages.length,2);}finally{restored.close();}
  }finally{f.close();}
});
test('unloaded chats remain valid recipients when native model settings have no connected client',async()=>{
  const f=fixture();try{
    f.router.backendRequest=async(app,route,...args)=>{if(route.endsWith('/settings'))throw Error('no-client-found');return f.backendRequest(app,route,...args);};
    const message=await f.router.send({from,to,text:'wake unloaded recipient'});assert.equal(message.status,'queued');
  }finally{f.close();}
});

test('health notices never wake archived recipients and expire only known-unsent health jobs',async()=>{
  const f=fixture();try{
    f.router.state.healthSubscribers={one:{who:to}};
    f.router.recordHealth({app:'codex',ok:false},'failure');
    f.router.recordHealth({app:'codex',ok:true},'recovery');
    const notices=f.router.receive(to).messages;
    const ordinary=await f.router.send({from,to,text:'explicit collaboration'});
    f.router.state.jobs[notices[1].id].status=notices[1].status='unknown';
    f.router.backendRequest=async(app,route,...rest)=>route.startsWith('/v1/threads/')?{thread:{archived:true,status:{type:'idle'}}}:f.backendRequest(app,route,...rest);
    await f.router.processJob(f.router.state.jobs[notices[0].id]);
    assert.equal(f.sends.length,0);assert.deepEqual(f.router.state.healthSubscribers,{});
    assert.equal(notices[0].status,'expired');assert.equal(f.router.state.jobs[notices[0].id].skippedReason,'health_recipient_archived');
    assert.equal(notices[1].status,'unknown');assert.equal(f.router.state.jobs[ordinary.id].status,'queued');
    const restored=new PeerRouter({directory:f.directory,backendRequest:f.backendRequest,pollMs:1e9});
    try{assert.deepEqual(restored.state.healthSubscribers,{});assert.equal(restored.state.messages[notices[0].id].status,'expired');}finally{restored.close();}
    await assert.rejects(f.router.setHealthSubscription({from:to,subscribe:true}),/Archived/);
  }finally{f.close();}
});

test('offline unsubscribe cancels queued health notices and does not retry uncertain or dispatched work',async()=>{
  const f=fixture();try{
    f.router.state.healthSubscribers={one:{who:to}};
    for(let i=0;i<4;i++)f.router.recordHealth({app:'codex',ok:false},'failure');
    const notices=f.router.receive(to).messages;
    for(const [i,status] of [[1,'unknown'],[2,'dispatching'],[3,'delivered']])f.router.state.jobs[notices[i].id].status=notices[i].status=status;
    f.router.backendRequest=async()=>{throw Error('desktop offline');};
    await f.router.setHealthSubscription({from:to,subscribe:false});
    assert.deepEqual(f.router.state.healthSubscribers,{});assert.equal(notices[0].status,'expired');
    assert.deepEqual(notices.slice(1).map(m=>m.status),['unknown','dispatching','delivered']);
  }finally{f.close();}
});

test('health delivery rechecks unsubscribe after a slow native read and applies changed app filters',async()=>{
  const f=fixture();try{
    f.router.state.healthSubscribers={one:{who:to}};
    f.router.recordHealth({app:'codex',ok:false},'failure');
    const notice=f.router.receive(to).messages[0];let release,started;
    const entered=new Promise(resolve=>{started=resolve;});
    f.router.backendRequest=async()=>{started();return new Promise(resolve=>{release=resolve;});};
    const pending=f.router.processJob(f.router.state.jobs[notice.id]);await entered;
    await f.router.setHealthSubscription({from:to,subscribe:false});release({thread:{status:{type:'idle'}}});await pending;
    assert.equal(f.sends.length,0);assert.equal(notice.status,'expired');
    f.router.state.healthSubscribers={one:{who:to}};
    f.router.recordHealth({app:'codex',ok:false},'failure');
    const filtered=f.router.receive(to).messages.at(-1);
    f.router.state.healthSubscribers.one.apps=['claude'];
    await f.router.processJob(f.router.state.jobs[filtered.id]);assert.equal(filtered.status,'expired');
    f.router.state.healthSubscribers.one.apps=null;
    f.router.recordHealth({app:'codex',ok:false},'failure');
    const protectedNotice=f.router.receive(to).messages.at(-1);
    fs.writeFileSync(path.join(f.directory,'protected-threads.json'),JSON.stringify({threadIds:[to.threadId]}));
    await f.router.processJob(f.router.state.jobs[protectedNotice.id]);assert.equal(protectedNotice.status,'expired');
  }finally{f.close();}
});
test('legacy unconfirmed messages do not inflate current pending consumption counts; archive is not ack',async()=>{
  const f=fixture();try{
    const m=await f.router.send({from,to,text:'old notice',expectReply:false});await f.tick();delete m.protocolVersion;delete m.consumption;
    const receipt=f.router.receipt(to,null);assert.equal(receipt.unconfirmedDeliveredCount,0);assert.equal(receipt.legacyUnconfirmedCount,1);
    await assert.rejects(async()=>f.router.archiveMessages({from,messageIds:[m.id],reason:'wrong inbox'}),/recipient/);
    const result=f.router.archiveMessages({from:to,messageIds:[m.id],reason:'Historical completed notice'});
    assert.equal(result.consumptionUnchanged,true);assert.equal(m.consumption,undefined);assert.equal(result.receipt.legacyUnconfirmedCount,0);
    assert.equal(f.router.receive(to).messages.length,0);assert.equal(f.router.receive(to,'',true).messages.length,1);
    assert.equal(f.router.receive(to,'',true,true).messages[0].text,undefined);
    assert.equal(f.router.receive(to,m.id).messages.length,0);
  }finally{f.close();}
});
test('archiving is atomic and cannot hide active or uncertain work',async()=>{
  const f=fixture();try{
    const done=await f.router.send({from,to,text:'completed notice',expectReply:false});await f.tick();f.setTask('running');const active=await f.router.send({from,to,text:'active'});await f.tick();
    assert.throws(()=>f.router.archiveMessages({from:to,messageIds:[done.id,active.id],reason:'must fail atomically'}),/terminal/);assert.equal(done.archivedAt,undefined);assert.equal(active.consumption.status,'unconfirmed');
  }finally{f.close();}
});
