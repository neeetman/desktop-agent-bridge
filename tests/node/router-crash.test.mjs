import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a stalled destination cannot block intake or another lane; hard restart reconciles without reposting', {timeout:20000}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-crash-'));
  const fixture=new URL('../fixtures/router-crash.mjs',import.meta.url);
  let child,connection;
  async function start() {
    child=fork(fixture,[directory],{stdio:['ignore','ignore','inherit','ipc']});
    await once(child,'message');
    connection=JSON.parse(fs.readFileSync(path.join(directory,'connection.json')));
  }
  async function stop() {
    const exited=once(child,'exit');
    child.kill('SIGKILL');await exited;
  }
  async function post(route,data) {
    const res=await fetch(connection.baseUrl+route,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify(data)});
    return {status:res.status,...await res.json()};
  }
  async function until(check) {
    for(let i=0;i<150;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40));}
    assert.fail('delivery deadline exceeded');
  }
  const from={app:'codex',threadId:'operator'};
  const input={from,to:{app:'claude',threadId:'slow'},messageId:'operator-1',text:'first',expectReply:false};
  try {
    await start();
    const result=await Promise.all([post('/v1/send',input),post('/v1/send',input)]);
    assert.equal(result[0].id,result[1].id);
    assert.equal((await post('/v1/send',{...input,text:'different'})).code!==undefined,true);
    const other=await post('/v1/send',{...input,to:{app:'deepseek',threadId:'fast'},messageId:'operator-2'});
    await until(async()=>(await post('/v1/message',{id:other.id})).delivery?.stage==='delivered');
    await until(()=>fs.existsSync(path.join(directory,'accepted')));
    await stop();await start();
    await until(async()=>(await post('/v1/message',{from,id:'operator-1'})).delivery?.stage==='delivered');
    assert.equal(fs.readFileSync(path.join(directory,'accepted'),'utf8'),'1');
    assert.equal((await post('/v1/message',{from:{...from,threadId:'different'},id:'operator-1'})).status,404);
  }finally{if(child&&child.exitCode===null&&!child.signalCode)await stop();fs.rmSync(directory,{force:true,recursive:true});}
});
