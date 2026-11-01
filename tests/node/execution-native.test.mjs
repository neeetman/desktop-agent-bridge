import {sourcePath} from '../../src/lib/paths.mjs';
import {projectURL} from "../../src/lib/paths.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import policy from '../../src/core/execution-policy.cjs';
const require=createRequire(import.meta.url);
function harness(shared={threads:{managed:{cwd:process.cwd(),sandboxMode:'workspace-write',writableRoots:[],approvalPolicy:'on-request'}},requests:{}}){
 let state=structuredClone(shared),handler;const calls=[],starts=[];let active=false,unloaded=false,protectedIds=[],loadedPages=[[]];
 const conversation={cwd:process.cwd(),latestModel:'test-model',requests:[],latestThreadSettings:{},currentPermissions:{}};
 const manager={hostId:'local',disposed:false,settings:{},resumeConversation:async()=>{unloaded=false;return {status:'ready'};},startConversation:async args=>{starts.push(args);return {status:'created',conversationId:'managed'};},setThreadTitle:async()=>{},getConversation:id=>id==='managed'&&!unloaded?conversation:null,getThreadExecutionState:()=>({inProgress:active}),readThread:async()=>{if(unloaded)throw Error('thread not found: managed');return {thread:{status:{type:active?'active':'idle'}}};},getThreadProjectAssignment:async()=>null,updateThreadSettingsForNextTurn:async(id,settings)=>{calls.push(settings);conversation.latestThreadSettings=settings;return true;},addConversationStateCallback:()=>()=>{},addApprovalRequestListener:()=>()=>{}};
 const fsMock={readFileSync(file){if(file.endsWith('codex-execution-compatibility.json'))return JSON.stringify({helperRevision:'fixture'});if(file.endsWith('connection.json'))return JSON.stringify({token:'fixture-token'});if(file.endsWith('protected-threads.json'))return JSON.stringify({threadIds:protectedIds});throw Error('Unexpected filesystem read '+file);}};
 const wrappedPolicy={...policy,validate:input=>policy.validate(input,{allowedWritableRoots:[process.cwd()]}),loadState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);}};
 const runtime={process:{type:'browser',mainModule:{require:id=>id==='node:fs'?fsMock:id==='electron'?{app:{getVersion:()=>''}}:id==='node:worker_threads'?{isMainThread:true}:id==='node:module'?{_cache:{}}:id==='node:net'?{createServer:fn=>{handler=fn;return {listening:true,on(){},listen(){},close(){}};}}:id.endsWith('execution-policy.cjs')?wrappedPolicy:id.endsWith('helper-binding.cjs')?require(sourcePath(process.cwd(),'helper-binding.cjs')):require(id)}},module:{exports:{}},__codexExecutionManager:manager,__codexExecutionConnection:{registerInternalNotificationHandler:()=>()=>{},sendAppServerRequest:async(method,args)=>{if(method!=='thread/loaded/list')throw Error('Unexpected native request');const page=args.cursor===null?0:Number(args.cursor);return {data:loadedPages[page],nextCursor:page+1<loadedPages.length?String(page+1):null};}}};
 vm.runInNewContext(fs.readFileSync(projectURL("codex-main-execution.cjs"),'utf8'),runtime);runtime.module.exports(process.cwd());
 const rpc=(method,extra={})=>new Promise(resolve=>{const socket=new EventEmitter();socket.setTimeout=()=>{};socket.end=text=>resolve(JSON.parse(text));socket.destroy=()=>{};handler(socket);socket.emit('data',Buffer.from(JSON.stringify({method,threadId:'managed',token:'fixture-token',...extra})+'\n'));});
 return {rpc,calls,starts,state:()=>state,setActive:value=>{active=value;},setUnloaded:value=>{unloaded=value;},setPending:value=>{conversation.requests=value?[{id:1,method:'item/commandExecution/requestApproval'}]:[];},setLoadedPages:pages=>{loadedPages=pages;},protect:ids=>{protectedIds=ids;}};
}
test('native full-access updates persist and a replacement helper restores them before later wakes',async()=>{
 const h=harness(),r=await h.rpc('set_permissions',{policy:{sandboxMode:'danger-full-access'}});
 assert.equal(r.error,undefined);assert.equal(r.nextTurnSettings.approvalPolicy,'never');assert.equal(h.calls.at(-1).sandboxPolicy.type,'dangerFullAccess');assert.equal(h.state().threads.managed.sandboxMode,'danger-full-access');
 const restored=harness(h.state());await restored.rpc('prepare');assert.equal(restored.calls.at(-1).sandboxPolicy.type,'dangerFullAccess');assert.equal(restored.calls.at(-1).approvalPolicy,'never');
});
test('native permission updates reject active, approval-waiting, protected and unmanaged chats without saving',async()=>{
 const h=harness(),request=()=>h.rpc('set_permissions',{policy:{sandboxMode:'danger-full-access'}});
 h.setActive(true);assert.equal((await request()).status,409);h.setActive(false);h.setPending(true);assert.equal((await request()).status,409);h.setPending(false);h.protect(['managed']);assert.equal((await request()).status,409);h.protect([]);assert.equal((await h.rpc('set_permissions',{threadId:'unmanaged',policy:{sandboxMode:'danger-full-access'}})).status,403);
 assert.equal(h.calls.length,0);assert.equal(h.state().threads.managed.sandboxMode,'workspace-write');
});

test('full-access creation sends both native sandbox and startup config without workspace-only constraints',async()=>{
 const h=harness(),r=await h.rpc('create',{args:{requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',cwd:process.cwd(),sandboxMode:'danger-full-access'}});assert.equal(r.error,undefined);assert.equal(h.starts.length,1);assert.equal(h.starts[0].permissionsConfig.sandboxPolicy.type,'dangerFullAccess');assert.equal(h.starts[0].config.sandbox_mode,'danger-full-access');assert.equal(h.starts[0].config.approval_policy,'never');assert.equal(h.starts[0].config.sandbox_workspace_write,undefined);
});

test('an unloaded managed chat is resumed before permission updates',async()=>{
 const h=harness();h.setUnloaded(true);const r=await h.rpc('set_permissions',{policy:{sandboxMode:'danger-full-access'}});assert.equal(r.error,undefined);assert.equal(r.nextTurnSettings.sandboxMode,'danger-full-access');assert.equal(h.calls.length,1);
});
test('native maintenance refuses a busy conversation that appears only on the second loaded-thread page',async()=>{
 const h=harness();h.setLoadedPages([[],['managed']]);h.setActive(true);const result=await h.rpc('maintenance');assert.equal(result.authoritative,true);assert.equal(result.idle,false);h.setActive(false);assert.equal((await h.rpc('maintenance')).idle,true);
});
