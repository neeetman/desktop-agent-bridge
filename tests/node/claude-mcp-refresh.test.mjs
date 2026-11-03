import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshClaudeMcp} from '../../src/cli/bridge-cli.mjs';
test('Claude MCP reconnect addresses one server and surfaces native rejection',async()=>{
 const calls=[];
 const result=await refreshClaudeMcp('test-session',undefined,async(...args)=>{calls.push(args);return {result:{}};});
 assert.deepEqual(calls[0],['native',{payload:{nativeMethod:'mcpReconnect',args:['test-session','desktop-bridge']}}]);
 assert.equal(result.workerVerificationRequired,true);
 await assert.rejects(refreshClaudeMcp('test-session','desktop-bridge',async()=>({result:{error:'Session not running'}})),/Session not running/);
 assert.equal((await refreshClaudeMcp('test-session','other',async()=>({result:{queued:true}}))).deferred,true);
 await assert.rejects(refreshClaudeMcp(undefined),/requires --thread/);
});
