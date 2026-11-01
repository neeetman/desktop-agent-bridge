import test from 'node:test';
import assert from 'node:assert/strict';
import {publicResult,codexModelCatalog,resolveSelection,matchRegisteredCwd,errorData} from '../../src/core/collaboration.mjs';
import {normalizeExecution} from '../../src/core/contracts.mjs';
import {callPeerTool} from '../../src/mcp/peer-call.mjs';
import {DesktopTools} from '../../src/adapters/codex/native.mjs';
import executionPolicy from '../../src/core/execution-policy.cjs';
import {startRouter} from '../../src/mcp/peer-router.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('tokens are recursively removed without removing scoped credential file paths',()=>{
  const value=publicResult({callback:{token:'secret-a',credentialsFile:'local.json'},taskCallback:{token:'secret-b'},items:[{apiKey:'secret-c',text:'keep'}]});
  assert.equal(JSON.stringify(value).includes('secret-'),false);assert.equal(value.callback.credentialsFile,'local.json');assert.equal(value.items[0].text,'keep');
});
test('MCP error data preserves a machine-readable HTTP status and stable code',()=>{
  const error=errorData(Object.assign(new Error('cwd does not exist'),{status:400}));
  assert.deepEqual(error,{code:'INVALID_ARGUMENT',message:'cwd does not exist',httpStatus:400});
  assert.equal(errorData(new Error('identity mismatch')).httpStatus,null);
});
test('live model declaration supplies IDs and model-specific efforts; aliases never invent availability',()=>{
  const c=codexModelCatalog('Models: gpt-6.1-sol (Latest model.; supported reasoning efforts: low, medium, high), gpt-6-luna (Fast.; supported reasoning efforts: low, medium).');
  assert.equal(resolveSelection(c,'sol 6.1','medium'),'gpt-6.1-sol');
  assert.equal(normalizeExecution({model:'sol 6.1',effort:'median'}).effort,'medium');
  assert.throws(()=>resolveSelection(c,'gpt-6-luna','ultra'),/supports/);
  assert.throws(()=>resolveSelection({models:[],aliases:c.aliases},'sol 6.1'),/Unknown/);
  assert.throws(()=>codexModelCatalog('unknown format'),/changed/);
});
test('cwd must exactly match the selected native project and cannot fall back to a parent checkout',()=>{
  const projects=[{projectId:'main',path:'D:\\ExampleProject'},{projectId:'worktree',path:'D:\\ExampleProject-work\\wt\\test'}];
  assert.equal(matchRegisteredCwd(projects,'d:/exampleproject-work/wt/test/').projectId,'worktree');
  assert.throws(()=>matchRegisteredCwd(projects,'D:/ExampleProject-work/wt/missing'),/refused before dispatch/);
  assert.throws(()=>matchRegisteredCwd(projects,'D:/ExampleProject-work/wt/test','main'),/not an exactly matching/);
  assert.throws(()=>normalizeExecution({threadId:'active-chat',cwd:'D:/ExampleProject'}),/keeps/);
});
test('Codex rejects unregistered cwd before any create or settings mutation',async context=>{
  const validate=executionPolicy.validate;
  context.mock.method(executionPolicy,'validate',input=>validate(input,{allowedWritableRoots:[]}));
  const tools=new DesktopTools('test','caller'),calls=[];
  tools.call=async name=>{calls.push(name);return {projects:[]};};
  await assert.rejects(tools.prepareExecution({cwd:process.cwd(),target:{type:'projectless'}}),/no session was created/);
  assert.deepEqual(calls,['list_projects']);
});
test('new MCP tools route explicit identity and creation input without accepting caller-controlled transport fields',async()=>{
  const calls=[],ctx={request:async(route,body)=>{calls.push({route,body});return {};},self:async()=>({app:'claude',threadId:'self'}),identity:async()=>({})};
  await callPeerTool('bridge_create_task',{toApp:'codex',prompt:'test',model:'sol 6.1',effort:'median',cwd:'D:/work',writableRoots:['D:/work'],sandboxMode:'workspace-write',approvalPolicy:'on-request',idempotencyKey:'v1',token:'must-not-forward',callbackMode:'peer'},ctx);
  assert.equal(calls[0].body.from.threadId,'self');assert.equal(calls[0].body.input.model,'sol 6.1');assert.equal(calls[0].body.input.token,undefined);assert.equal(calls[0].body.input.callbackMode,undefined);
  assert.deepEqual(calls[0].body.input.writableRoots,['D:/work']);assert.equal(calls[0].body.input.sandboxMode,'workspace-write');assert.equal(calls[0].body.input.approvalPolicy,'on-request');
  await callPeerTool('bridge_set_permissions',{toApp:'codex',toThreadId:'managed',sandboxMode:'danger-full-access'},ctx);const update=calls.pop();assert.equal(update.route,'/v1/set-permissions');assert.equal(update.body.from.threadId,'self');assert.equal(update.body.input.sandboxMode,'danger-full-access');
  await callPeerTool('bridge_settings',{toApp:'codex',toThreadId:'id'},ctx);assert.equal(calls[1].body.route,'/v1/threads/id/settings');
  await callPeerTool('bridge_ack',{messageId:'m'},ctx);assert.equal(calls[2].route,'/v1/ack');
  await callPeerTool('bridge_models',{},ctx);assert.equal(calls[3].body.route,'/v1/models');
});
test('HTTP MCP creation is narrow, uses a scoped idempotency key, and never returns callback tokens',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-collab-')),calls=[];
  const running=await startRouter({directory,port:0,backendRequest:async(app,route,method,body,key)=>{calls.push({app,route,method,body,key});return method==='POST'?{id:'new-task',callback:{token:'must-not-leak',credentialsFile:'scoped.json'}}:{settings:{}};}});
  const request=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${running.server.address().port}${route}`,{method:'POST',headers:{Authorization:`Bearer ${running.router.state.token}`},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
  try{
    const result=await request('/v1/create-task',{from:{app:'claude',threadId:'source'},app:'codex',idempotencyKey:'spec-v2',input:{prompt:'authorized test',model:'sol 6.1',effort:'median'}});
    assert.equal(result.status,202);assert.equal(result.value.callback.token,undefined);assert.equal(result.value.callback.credentialsFile,'scoped.json');assert.equal(calls.at(-1).key,'mcp-create:claude:source:spec-v2');
    assert.ok(calls.at(-1).body.prompt.startsWith('[bridge '));assert.match(calls.at(-1).body.prompt,/"kind":"task_creation"/);assert.match(calls.at(-1).body.prompt,/"from":"claude:source"/);
    assert.equal((await request('/v1/create-task',{from:{app:'claude',threadId:'source'},app:'codex',idempotencyKey:'x',input:{threadId:'existing-active',prompt:'must not steer'}})).status,400);
    const mutations=calls.filter(x=>x.method==='POST').length;
    assert.equal((await request('/v1/native',{app:'codex',route:'/v1/tasks',method:'POST'})).status,400);assert.equal(calls.filter(x=>x.method==='POST').length,mutations);
    const permissions=await request('/v1/set-permissions',{from:{app:'claude',threadId:'source'},app:'codex',threadId:'managed',input:{sandboxMode:'danger-full-access'}});assert.equal(permissions.status,200);assert.equal(calls.at(-1).route,'/v1/threads/managed/permissions');assert.equal(calls.at(-1).body.sandboxMode,'danger-full-access');
    const before=calls.filter(x=>x.method==='POST').length;assert.equal((await request('/v1/set-permissions',{from:{app:'claude',threadId:'source'},app:'claude',threadId:'managed',input:{sandboxMode:'danger-full-access'}})).status,400);assert.equal(calls.filter(x=>x.method==='POST').length,before);
  }finally{await running.close();assert.ok(path.basename(directory).startsWith('bridge-collab-')&&path.dirname(directory)===path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});}
});
