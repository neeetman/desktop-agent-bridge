import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureWindow,packageFamily} from '../../src/adapters/codex/codex-window.mjs';
import {DesktopTools} from '../../src/adapters/codex/native.mjs';

const build={pid:42,executable:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'};
const windows=process.platform==='win32'?test:test.skip;

test('the package family comes from the MSIX install path',()=>{
 assert.equal(packageFamily(build.executable),'OpenAI.Codex_2p2nqsd0c76g0');
 assert.equal(packageFamily('C:\\tools\\ChatGPT.exe'),null);
});
windows('reads fail fast with a closed window, and nothing is opened',async()=>{
 let opened=0;
 await assert.rejects(ensureWindow(build,{visible:async()=>false,open:()=>opened++}),error=>error.code==='CODEX_WINDOW_CLOSED'&&error.dispatchNotStarted===true);
 assert.equal(opened,0);
 assert.deepEqual(await ensureWindow(build,{visible:async()=>true,open:()=>opened++}),{checked:true,visible:true});
});
windows('sends reopen the window and wait for it',async()=>{
 let opened=0,checks=0;
 const result=await ensureWindow(build,{reopen:true,visible:async()=>opened>0&&++checks>2,open:executable=>{assert.equal(executable,build.executable);opened++;},sleep:async()=>{}});
 assert.deepEqual(result,{checked:true,visible:true,reopened:true});assert.equal(opened,1);
 await assert.rejects(ensureWindow(build,{reopen:true,visible:async()=>false,open:()=>{},sleep:async()=>{},waitMs:1000}),/could not be reopened/);
});
test('an unknown process or a failed check never blocks the call',async()=>{
 assert.deepEqual(await ensureWindow(undefined),{checked:false});
 if(process.platform==='win32')assert.deepEqual(await ensureWindow(build,{visible:async()=>{throw Error('python missing');}}),{checked:false});
});
test('native tool calls check the window first: reads never reopen it, sends do',async()=>{
 const seen=[];
 const tools=new DesktopTools('fixture','caller',{guardRuntime:async(_a,_c,fn)=>fn({binding:{generation:'g',activationEpoch:1},runningBuild:build}),
  windowGuard:async(runningBuild,options)=>{seen.push([runningBuild.pid,options.reopen]);if(!options.reopen)throw Object.assign(Error('closed'),{code:'CODEX_WINDOW_CLOSED'});}});
 let native=0;tools.rpc.request=async method=>{native++;return method==='tools/list'?{tools:[{name:'send_message_to_thread',inputSchema:{type:'object'}}]}:{contentItems:[{text:'{}'}]};};
 await assert.rejects(tools.rawCall('list_threads',{}),{code:'CODEX_WINDOW_CLOSED'});
 assert.equal(native,0,'a closed window stops the read before the native pipe');
 await tools.rawCall('send_message_to_thread',{threadId:'t',message:'m'}).catch(()=>{});
 assert.deepEqual(seen,[[42,false],[42,true]]);
 assert.ok(native>0);
});
