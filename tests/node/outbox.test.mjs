import test from 'node:test';
import assert from 'node:assert/strict';
import {PeerRouter} from '../../src/mcp/peer-router.mjs';
import {callPeerTool} from '../../src/mcp/peer-call.mjs';

test('outbox scopes sender, pagination and status without disclosing prompts',()=>{
  const router=Object.create(PeerRouter.prototype);
  const from={app:'codex',threadId:'x'},other={app:'claude',threadId:'x'};
  router.state={messages:{},jobs:{}};
  for(const [id,sender,status] of [['a',from,'queued'],['b',other,'unknown'],['c',from,'unknown']]){
    router.state.messages[id]={id,from:sender,to:other,text:'private'};
    router.state.jobs[id]={status};
  }
  const page=router.outbox({from,limit:1});
  assert.equal(page.nextCursor,'c');
  assert.deepEqual(router.outbox({from,after:'c'}).receipts.map(r=>r.id),['a']);
  assert.equal(router.outbox({from,stage:'unknown'}).receipts.length,1);
  assert.ok(!JSON.stringify(page).includes('private'));
  assert.throws(()=>router.outbox({from,after:'b'}));
});
test('timeout returns the exact transmitted lookup key even if caller omitted it',async()=>{
  let transmitted;
  const invoke=()=>callPeerTool('bridge_send',{toApp:'claude',toThreadId:'x',text:'test'}, {
    self:async()=>({app:'codex',threadId:'c'}),request:async(_,body)=>{
      transmitted=body.messageId;throw new DOMException('timeout','TimeoutError');
    }
  });
  await assert.rejects(invoke(),e=>e.code==='SEND_RECEIPT_UNCONFIRMED'&&!!transmitted&&e.lookupMessageId===transmitted);
});
