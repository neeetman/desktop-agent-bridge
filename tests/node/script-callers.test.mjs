import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRouter} from '../../src/mcp/peer-router.mjs';
import {setupCaller,createTaskAsScript,tokenFile,readConfig,scriptPrompt} from '../../src/mcp/script-callers.mjs';
import {scriptCommand} from '../../src/cli/bridge-cli.mjs';
import {creationOrigin} from '../../src/core/contracts.mjs';

const PROJECT=path.resolve('D:/UECapture');
const restrict=()=>{};

async function fixture({maxTasksPerHour=2}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'script-callers-'));
  const directory=path.join(root,'router'),env={DESKTOP_BRIDGE_SCRIPT_HOME:path.join(root,'profile')};
  const posts=[],tasks=new Map();
  // Synthetic backend with the same Idempotency-Key behaviour as the native bridge.
  const backendRequest=async(app,route,method,body,key)=>{
    if(method!=='POST')return {};
    posts.push({app,route,body,key});
    if(tasks.has(key))return {...tasks.get(key),cachedResult:true};
    const task={id:`task-${tasks.size+1}`,status:'running'};tasks.set(key,task);return task;
  };
  const running=await startRouter({directory,port:0,backendRequest});
  running.router.tick=async()=>{};
  const setup=setupCaller({routerDirectory:directory,env,restrict,name:'uecapture-ops-poller',projects:[PROJECT],maxTasksPerHour,authorization:'对于需要起会话的可以用 desktop bridge 启一个会话'});
  let counter=0;
  const create=(overrides={})=>createTaskAsScript({routerDirectory:directory,env,name:'uecapture-ops-poller',title:'ops event',prompt:'handle event',idempotencyKey:`event-key-${++counter}`,...overrides});
  const raw=async(headers,body)=>{
    const port=running.server.address().port;
    const response=await fetch(`http://127.0.0.1:${port}/v1/script/create-task`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {root,directory,env,posts,running,setup,create,raw,async close(){await running.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('setup stores only a token digest in the router config and writes the token to the profile',async()=>{
  const f=await fixture();
  try{
    const token=fs.readFileSync(tokenFile('uecapture-ops-poller',f.env),'utf8');
    assert.match(token,/^[\w-]{40,}$/);
    const config=fs.readFileSync(path.join(f.directory,'script-callers.json'),'utf8');
    assert.equal(config.includes(token),false);
    const caller=readConfig(f.directory).callers['uecapture-ops-poller'];
    assert.deepEqual(caller.toApps,['claude']);
    assert.deepEqual(caller.projectIds,[PROJECT.toLowerCase()]);
    assert.equal(JSON.stringify(f.setup).includes(token),false);
    assert.throws(()=>setupCaller({routerDirectory:f.directory,env:f.env,restrict,name:'uecapture-ops-poller',projects:[PROJECT],maxTasksPerHour:2,authorization:'x'}),{code:'CALLER_EXISTS'});
    assert.throws(()=>setupCaller({routerDirectory:f.directory,env:f.env,restrict,name:'other',projects:[PROJECT],maxTasksPerHour:2,authorization:'x',toApp:'codex'}),/only target claude/);
  }finally{await f.close();}
});

test('creates a Claude task attributed to the script caller under standing owner authorization',async()=>{
  const f=await fixture();
  try{
    const task=await f.create({idempotencyKey:'evt-0001-handoff'});
    assert.equal(task.id,'task-1');
    assert.equal(task.caller,'script:uecapture-ops-poller');
    assert.equal(task.authorizationBasis,'standing-owner');
    const [post]=f.posts;
    assert.equal(post.app,'claude');
    assert.equal(post.key,'script-create:uecapture-ops-poller:evt-0001-handoff');
    assert.equal(post.body.projectId,PROJECT.toLowerCase());
    assert.equal(post.body.title,'ops event');
    const header=JSON.parse(post.body.prompt.match(/^\[bridge (\{[^\n]+\})\]/)[1]);
    assert.deepEqual({from:header.from,kind:header.kind,authorization:header.authorization,expectReply:header.expectReply},{from:'script:uecapture-ops-poller',kind:'task_creation',authorization:'standing-owner',expectReply:false});
    assert.match(post.body.prompt,/常设授权/);
    assert.match(post.body.prompt,/handle event$/);
  }finally{await f.close();}
});

test('missing or wrong token is rejected before anything is dispatched',async()=>{
  const f=await fixture();
  try{
    fs.rmSync(tokenFile('uecapture-ops-poller',f.env));
    await assert.rejects(f.create(),{code:'SCRIPT_TOKEN_MISSING'});
    fs.writeFileSync(tokenFile('uecapture-ops-poller',f.env),'not-the-token');
    await assert.rejects(f.create(),{code:'SCRIPT_UNAUTHORIZED',status:401});
    const noHeader=await f.raw({},{toApp:'claude',idempotencyKey:'evt-raw-0001',input:{prompt:'x'}});
    assert.equal(noHeader.status,401);
    // The router token is not a script credential and vice versa.
    const routerToken=f.running.router.state.token;
    const crossed=await f.raw({Authorization:`Bearer ${routerToken}`,'X-Bridge-Script-Caller':'uecapture-ops-poller'},{toApp:'claude',idempotencyKey:'evt-raw-0002',input:{prompt:'x'}});
    assert.equal(crossed.status,401);
    assert.equal(f.posts.length,0);
  }finally{await f.close();}
});

test('non-whitelisted project, app or input fields are refused',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.create({projectId:path.resolve('D:/Other')}),{code:'SCRIPT_PROJECT_FORBIDDEN',status:403});
    const token=fs.readFileSync(tokenFile('uecapture-ops-poller',f.env),'utf8');
    const headers={Authorization:`Bearer ${token}`,'X-Bridge-Script-Caller':'uecapture-ops-poller'};
    assert.equal((await f.raw(headers,{toApp:'codex',idempotencyKey:'evt-raw-0003',input:{prompt:'x'}})).body.code,'SCRIPT_APP_FORBIDDEN');
    assert.equal((await f.raw(headers,{toApp:'claude',idempotencyKey:'evt-raw-0004',input:{prompt:'x',sandboxMode:'danger-full-access'}})).status,400);
    assert.equal((await f.raw(headers,{toApp:'claude',input:{prompt:'x'}})).body.code,'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(f.posts.length,0);
  }finally{await f.close();}
});

test('rate limit counts new tasks per hour and replays do not count',async()=>{
  const f=await fixture({maxTasksPerHour:2});
  try{
    await f.create({idempotencyKey:'evt-rate-0001'});
    await f.create({idempotencyKey:'evt-rate-0002'});
    await f.create({idempotencyKey:'evt-rate-0001'});
    const error=await f.create({idempotencyKey:'evt-rate-0003'}).catch(error=>error);
    assert.equal(error.code,'SCRIPT_RATE_LIMITED');
    assert.equal(error.status,429);
    assert.ok(error.retryAfterSeconds>0&&error.retryAfterSeconds<=3600);
    assert.equal(f.posts.length,3);
    // Entries older than an hour stop counting.
    for(const row of Object.values(f.running.router.state.scriptTasks))row.reservedAt-=3600001;
    assert.equal((await f.create({idempotencyKey:'evt-rate-0003'})).id,'task-3');
    const audit=fs.readFileSync(path.join(f.directory,'script-callers.jsonl'),'utf8');
    assert.match(audit,/rate_limited/);
    assert.equal(/handle event/.test(audit),false);
  }finally{await f.close();}
});

test('same idempotency key returns the same task; a changed request with that key conflicts',async()=>{
  const f=await fixture();
  try{
    const first=await f.create({idempotencyKey:'evt-same-0001'});
    const again=await f.create({idempotencyKey:'evt-same-0001'});
    assert.equal(again.id,first.id);
    assert.equal(again.cachedResult,true);
    assert.equal(f.posts[0].key,f.posts[1].key);
    assert.equal(f.posts[0].body.prompt,f.posts[1].body.prompt);
    await assert.rejects(f.create({idempotencyKey:'evt-same-0001',prompt:'different'}),{code:'IDEMPOTENCY_CONFLICT',status:409});
    assert.equal(f.posts.length,2);
  }finally{await f.close();}
});

test('CLI reads the prompt from a file and never takes the token as an argument',async()=>{
  const f=await fixture();
  try{
    const promptFile=path.join(f.root,'prompt.md');fs.writeFileSync(promptFile,'\uFEFFhandle event');
    const result=await scriptCommand(['script','create-task','--caller','uecapture-ops-poller','--title','ops event','--prompt-file',promptFile,'--idempotency-key','evt-cli-0001'],{routerDirectory:f.directory,env:f.env});
    assert.equal(result.caller,'script:uecapture-ops-poller');
    assert.match(f.posts[0].body.prompt,/\n\nhandle event$/);
    await assert.rejects(scriptCommand(['script','create-task','--caller','uecapture-ops-poller','--prompt-file',promptFile,'--idempotency-key','evt-cli-0002'],{routerDirectory:f.directory,env:f.env}),/--title is required/);
  }finally{await f.close();}
});

test('router unavailable reports that no task was created',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'script-callers-down-'));
  try{
    const env={DESKTOP_BRIDGE_SCRIPT_HOME:path.join(root,'profile')},directory=path.join(root,'router');
    setupCaller({routerDirectory:directory,env,restrict,name:'poller',projects:[PROJECT],maxTasksPerHour:1,authorization:'owner ok'});
    await assert.rejects(createTaskAsScript({routerDirectory:directory,env,name:'poller',title:'t',prompt:'p',idempotencyKey:'evt-down-0001'}),{code:'ROUTER_UNAVAILABLE',dispatchNotStarted:true});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('prompt header is not mistaken for a peer chat origin',()=>{
  const prompt=scriptPrompt({name:'poller',authorization:{statement:'ok',recordedAt:'2026-11-05T00:00:00.000Z'}},{prompt:'p'},'evt-key-0001');
  assert.equal(JSON.parse(prompt.match(/^\[bridge (\{[^\n]+\})\]/)[1]).from,'script:poller');
  assert.equal(creationOrigin(prompt,'script-create:poller:evt-key-0001'),null);
});
