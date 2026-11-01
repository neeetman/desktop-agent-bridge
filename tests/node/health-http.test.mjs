import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {startRouter} from '../../src/mcp/peer-router.mjs';

test('health HTTP remains responsive while a native read times out; confirmed outage and recovery each notify once', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-health-http-'));
  let now=Date.parse('2026-11-01T00:00:00Z'),slow=false,offline=false,running;
  const mock=http.createServer((req,res)=>{
    if(slow&&req.url.startsWith('/codex/v1/threads'))return;
    const failed=offline&&req.url==='/codex/health';
    res.writeHead(failed?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(failed?{error:'synthetic service unavailable'}:{ok:true,transport:'synthetic-http',items:[]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  try {
    const backend=`http://127.0.0.1:${mock.address().port}`;
    running=await startRouter({directory,port:0,healthOptions:{now:()=>now,policy:{responseWaitMs:20,nativeTimeoutMs:1000}},backendRequest:async(app,route,method,body,key,options)=>{
      const response=await fetch(backend+'/'+app+route,{signal:options.signal});
      const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});
      return result;
    }});
    running.router.tick=async()=>{};
    running.router.state.healthSubscribers={test:{who:{app:'codex',threadId:'synthetic-only'}}};
    const request=async()=>{
      const response=await fetch(`http://127.0.0.1:${running.server.address().port}/v1/health`,{
        method:'POST',headers:{Authorization:`Bearer ${running.router.state.token}`,'Content-Type':'application/json'},body:JSON.stringify({app:'all'}),signal:AbortSignal.timeout(5000),
      });
      assert.equal(response.status,200);return response.json();
    };
    await Promise.all(['codex','claude','deepseek'].map(app=>running.router.healthMonitor.probe(app)));
    assert.equal((await request()).ok,true);
    now+=30000;slow=true;
    const pending=await request();assert.equal(pending.checking,true);
    assert.equal(pending.results.find(row=>row.app==='claude').ok,true);
    assert.equal(pending.results.find(row=>row.app==='deepseek').ok,true);
    await running.router.healthMonitor.probe('codex');
    assert.equal(running.router.state.health.codex.failedStep,'native_threads');
    assert.equal(running.router.state.health.codex.status,'degraded');
    assert.equal(Object.keys(running.router.state.messages).length,0);
    slow=false;now+=30000;await running.router.healthMonitor.probe('codex');
    assert.equal(Object.keys(running.router.state.messages).length,0);
    offline=true;
    for(let i=0;i<4;i++){now+=30000;await running.router.healthMonitor.probe('codex');}
    assert.equal(Object.keys(running.router.state.messages).length,1);
    const failed=running.router.state.health.codex;
    assert.equal(failed.failedStep,'service_http');assert.equal(failed.steps[0].httpStatus,503);
    offline=false;now+=30000;await running.router.healthMonitor.probe('codex');
    assert.equal(Object.keys(running.router.state.messages).length,2);
    assert.ok(Object.values(running.router.state.messages).every(row=>row.to.threadId==='synthetic-only'&&!row.expectReply));
  } finally {
    if(running)await running.close();
    await new Promise(resolve=>{mock.close(resolve);mock.closeAllConnections();});
    assert.ok(directory.startsWith(path.join(os.tmpdir(),'bridge-health-http-')));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
