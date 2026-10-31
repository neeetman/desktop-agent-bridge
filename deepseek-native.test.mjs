import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from './deepseek-plugin.mjs';
import { DeepSeekNative, DeepSeekTools, deepseekTurns, deepseekSelection } from './deepseek-native.mjs';

test('native Host plugin activates, authorizes calls, binds each tool to the runtime Agent, and disposes the listener', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-plugin-'));
  const definitions = [], disposers = [];
  const services = { sessionController: { list: () => ({items:[{sessionId:'d1'}]}) }, workspaceRegistry: {}, agents: {}, tools: { register: value => definitions.push(value) } };
  const ctx = { ...services, get: key => services[key], effect: init => disposers.push(init()), on: () => {} };
  try {
    await apply(ctx, { directory, port: 0 });
    const connectionFile = path.join(directory, 'runtime/deepseek-native/connection.json');
    const native = new DeepSeekNative(connectionFile);
    assert.deepEqual(await native.request('list'), {items:[{sessionId:'d1'}]});
    const c = JSON.parse(fs.readFileSync(connectionFile));
    assert.equal((await fetch(c.baseUrl+'/health')).status, 401);
    const self = definitions.find(t => t.name.endsWith('__bridge_self'));
    const result = await self.execute({}, {agent:{session:{id:'d1'}}});
    assert.equal(JSON.parse(result.content[0].text).threadId, 'd1');
    assert.equal(JSON.parse(result.content[0].text).app, 'deepseek');
    await assert.rejects(self.execute({fromThreadId:'another'}, {agent:{session:{id:'d1'}}}), /disagrees/);
    await assert.rejects(self.execute({}, {}), /Agent is required/);
    disposers.splice(0).forEach(dispose=>dispose());
    await assert.rejects(native.request('list'));
  } finally { disposers.forEach(dispose=>dispose()); fs.rmSync(directory, {recursive:true,force:true}); }
});

test('durable DeepSeek turn boundaries preserve final replies and failures', () => {
  const events = [
    {type:'turn/start',data:{turn:1}},
    {type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'working'}]}}},
    {type:'assistant/message',seq:6,data:{message:{content:[{type:'text',text:'ACK'}]}}},
    {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    {type:'turn/start',data:{turn:2}},
    {type:'turn/end',data:{turn:2,reason:{kind:'error',error:{message:'bad request'}}}},
  ];
  const turns = deepseekTurns(events);
  assert.equal(turns[0].status,'completed'); assert.equal(turns[0].items[0].phase,'commentary'); assert.equal(turns[0].items[1].phase,'final_answer');
  assert.equal(turns[1].status,'failed'); assert.equal(turns[1].error.message,'bad request');
});

test('DeepSeek maps none to native off and rejects unsupported models/efforts before session creation', async () => {
  const catalog={default:{model:'flash'},groups:[{id:'deepseek',models:[{id:'flash',reasoning:{efforts:[{id:'off'},{id:'low'},{id:'high'},{id:'max'}]}}]}]};
  assert.deepEqual(deepseekSelection(catalog,'flash','none'),{provider:'deepseek',model:'flash',reasoningEffort:'off'});
  const tools=new DeepSeekTools(),calls=[];
  tools.native.request=async method=>{calls.push(method);if(method==='models')return catalog;throw Error('Unexpected mutation');};
  await assert.rejects(tools.call('create_thread',{target:{type:'project',projectId:'p'},model:'flash',thinking:'medium'}),/supports reasoning efforts/);
  await assert.rejects(tools.call('create_thread',{target:{type:'project',projectId:'p'},model:'retired'}),/Unknown DeepSeek model/);
  assert.deepEqual(calls,['models','models']);
});
