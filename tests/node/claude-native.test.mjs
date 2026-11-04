import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTools, claudeTurns } from '../../src/adapters/claude/claude-native.mjs';

test('Claude transcripts distinguish tool results, assistant progress, final answers and failures', () => {
  const turns = claudeTurns([
    { type: 'user', uuid: 'u1', message: { content: 'task' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'progress' }], stop_reason: 'tool_use' } },
    { type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', content: 'ok' },{type:'text',text:'tool-attached reminder'}] } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
    { type: 'result', uuid: 'r1', subtype: 'success', result: 'done' },
    { type: 'user', uuid: 'u2', message: { content: 'again' } },
    { type: 'result', uuid: 'r2', subtype: 'error_during_execution', errors: ['failed'] },
  ], {});
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, 'completed');
  assert.deepEqual(turns[0].items.map(item => [item.phase, item.text]), [['commentary', 'progress'], ['final_answer', 'done']]);
  assert.equal(turns[1].status, 'failed');
});

test('CLI-local model commands cannot create or interrupt tracked model turns', () => {
  const turns = claudeTurns([
    {type:'user',uuid:'local-name',message:{content:'<command-name>/model</command-name>\n<command-args>test</command-args>'}},
    {type:'user',uuid:'local-output',message:{content:'<local-command-stdout>Set model to test</local-command-stdout>'}},
    {type:'user',uuid:'actual',message:{content:'[bridge] actual request'}},
    {type:'assistant',message:{content:[{type:'text',text:'progress'}],stop_reason:'tool_use'}},
    {type:'user',uuid:'late-command',message:{content:[{type:'text',text:'<command-name>/model</command-name>'}]}},
    {type:'user',uuid:'late-error',message:{content:'<local-command-stderr>local output</local-command-stderr>'}},
    {type:'assistant',message:{content:[{type:'text',text:'done'}],stop_reason:'end_turn'}},
    {type:'user',uuid:'next',message:{content:'next request'}},
  ], {turnRunning:true});
  assert.deepEqual(turns.map(t=>t.id), ['actual','next']);
  assert.equal(turns[0].status,'completed');
  assert.equal(turns[0].supersededByTurnId,undefined);
  assert.deepEqual(turns[0].items.map(t=>t.text),['progress','done']);
  assert.equal(turns[1].status,'inProgress');
});

test('Claude effort setter returns void: verify metadata before sending and reject mismatches', async () => {
  const tools = new ClaudeTools(); const calls = [];
  tools.native = { async request(method, args) { calls.push([method, args]); if (method === 'getSession') return { effort: 'low' }; } };
  await tools.call('send_message_to_thread', { threadId: 't', thinking: 'low', prompt: 'wake' });
  assert.deepEqual(calls.map(call => call[0]), ['setEffort', 'getSession', 'sendMessage']);
  calls.length = 0;
  await assert.rejects(tools.call('send_message_to_thread', { threadId: 't', thinking: 'high', prompt: 'wake' }), /read back low/);
  assert.equal(calls.some(call => call[0] === 'sendMessage'), false);
});

test('Claude thread reads preserve native archive status for notification routing',async()=>{
  const tools=new ClaudeTools();
  tools.native={request:async(method)=>method==='getSession'?{sessionId:'archived-chat',isArchived:true}: {messages:[],hasMore:false}};
  const result=await tools.call('read_thread',{threadId:'archived-chat'});
  assert.equal(result.thread.archived,true);assert.equal(result.thread.id,'archived-chat');
});

test('historical final answers followed by a new user turn complete without relying on a missing result event',()=>{
 const turns=claudeTurns([{type:'user',uuid:'old',message:{content:'old task'}},{type:'assistant',uuid:'done',timestamp:'old-final-time',message:{content:[{type:'text',text:'old answer'}],stop_reason:'end_turn'}},{type:'user',uuid:'current',message:{content:'new task'}},{type:'assistant',uuid:'progress',message:{content:[{type:'text',text:'working'}],stop_reason:'tool_use'}}],{turnRunning:true,isRunning:true});
 assert.equal(turns[0].status,'completed');assert.equal(turns[0].completionEvidence,'native-final-message-before-next-user');assert.equal(turns[1].status,'inProgress');
 const unfinished=claudeTurns([{type:'user',uuid:'u',message:{content:'task'}},{type:'assistant',message:{content:[{type:'text',text:'progress'}],stop_reason:'tool_use'}},{type:'user',uuid:'v',message:{content:'interruption'}}],{});assert.equal(unfinished[0].status,'interrupted');assert.equal(unfinished[0].supersededByTurnId,'v');assert.equal(unfinished[0].items.some(item=>item.phase==='final_answer'),false);
});

test('tracked turn lookup pages native history by exact UUID and never substitutes a recent turn',async()=>{
 const tools=new ClaudeTools(),calls=[];
 tools.native={request:async(method,args)=>{calls.push([method,args]);if(method==='getSession')return {turnRunning:true,isRunning:true};if(args[1]==='')return {found:true,hasMore:true,messages:[{type:'user',uuid:'new',message:{content:'new task'}}]};return {found:true,hasMore:false,messages:[{type:'user',uuid:'old',message:{content:'old task'}},{type:'assistant',uuid:'old-final',message:{content:[{type:'text',text:'old answer'}],stop_reason:'end_turn'}}]};}};
 const turn=await tools.readTrackedTurn('chat','old');assert.equal(turn.id,'old');assert.equal(turn.status,'completed');assert.equal(turn.items.at(-1).text,'old answer');assert.equal(calls[1][1][1],'new');
 assert.equal(await tools.readTrackedTurn('chat','missing'),null);
});
