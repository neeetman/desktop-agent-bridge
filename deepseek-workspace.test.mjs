import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecution } from './contracts.mjs';
import { DeepSeekTools } from './deepseek-native.mjs';

test('workspace selector is explicit, DeepSeek-only, and rejects conflicting/existing-thread placement', () => {
  const execution=normalizeExecution({workspaceId:'w',environment:{type:'local'}},{allowWorkspace:true});
  assert.equal(execution.target.projectId,'w');
  assert.throws(()=>normalizeExecution({workspaceId:'w'}),/only supported/);
  assert.throws(()=>normalizeExecution({workspaceId:'w',projectId:'other'},{allowWorkspace:true}),/disagree/);
  assert.throws(()=>normalizeExecution({workspaceId:'w',threadId:'existing'},{allowWorkspace:true}),/existing thread/i);
});

test('DeepSeek preserves workspace membership separately from the current working subdirectory', async () => {
  const tools=new DeepSeekTools();
  const workspace={id:'w',title:'UECapture',path:'D:\\UECapture',sessionIds:['s']};
  tools.native.request=async method=>{
    if(method==='workspaces')return {items:[workspace]};
    if(method==='list')return {items:[{sessionId:'s',cwd:'D:\\UECapture',updatedAt:1,projections:{values:{title:'chat',workingDirectory:'D:\\UECapture\\engine'}}}]};
    if(method==='inspect')return {meta:{cwd:'D:\\UECapture'},events:[],status:'idle',projections:{values:{title:'chat',workingDirectory:'D:\\UECapture\\engine'}}};
    throw Error('Unexpected mutation');
  };
  const settings=(await tools.readSettings('s')).settings;
  assert.equal(settings.workspaceId,'w');assert.equal(settings.workspacePath,'D:\\UECapture');assert.equal(settings.cwd,'D:\\UECapture\\engine');assert.equal(settings.originCwd,'D:\\UECapture');
  const list=await tools.call('list_threads',{}),read=await tools.call('read_thread',{threadId:'s'});
  for(const row of [list.threads[0],read.thread]){assert.equal(row.workspaceId,'w');assert.equal(row.projectId,'w');assert.equal(row.workspaceName,'UECapture');assert.equal(row.cwd,'D:\\UECapture\\engine');}
});

test('workspace-selected creation passes the native workspace identity rather than a substitute cwd', async () => {
  const tools=new DeepSeekTools(),calls=[];
  tools.native.request=async(method,args)=>{calls.push({method,args});if(method==='create')return {sessionId:'s'};if(method==='prompt')return {accepted:true};throw Error('Unexpected method');};
  await tools.call('create_thread',{target:{type:'project',projectId:'w'},prompt:'check'});
  assert.equal(calls[0].args.workspaceId,'w');assert.equal(Object.hasOwn(calls[0].args,'cwd'),false);assert.equal(calls[1].args.sessionId,'s');
});
