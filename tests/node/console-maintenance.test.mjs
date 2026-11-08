import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const consoleRoot = new URL('../../src/console/', import.meta.url);
function mainFixture() {
  let complete;
  const context = {
    __dirname: path.dirname(fileURLToPath(new URL('main.cjs', consoleRoot))),
    process, console,
    require(name) {
      if(name === 'electron')return {app:{setName(){},setPath(){},getPath:()=>process.cwd(),requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{}};
      if(name === 'node:fs/promises')return {readFile:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}};
      if(name === 'node:child_process')return {execFile(_exe,_args,_options,callback){complete=callback;return {stdin:{on(){},end(){}}};}};
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('main.cjs',consoleRoot),'utf8')+
    '\nglobalThis.api={update,beginMaintenance,status:()=>updating};',context);
  return {...context.api,complete:(...args)=>complete(...args)};
}

test('an update blocked by background validation names the owner and preserves its lock',async()=>{
  const f=mainFixture();
  f.beginMaintenance('自动验收未知构建（最长约 17 分钟）');
  const owner=f.status();
  await assert.rejects(f.update('probe','codex'),/自动验收未知构建.*开始于/);
  assert.equal(f.status(),owner);
  assert.ok(!Number.isNaN(Date.parse(owner.startedAt)));
});

test('failed and successful console operations release maintenance for the next request',async()=>{
  const f=mainFixture();
  const failed=f.update('probe','codex');
  await new Promise(setImmediate);
  await assert.rejects(f.update('probe','claude'),/检查 codex 连接/);
  const rejected=assert.rejects(failed,/probe failed/);
  f.complete(Error('probe failed'),'','');
  await rejected;
  assert.equal(f.status(),null);
  const next=f.update('probe','claude');
  await new Promise(setImmediate);
  f.complete(null,JSON.stringify({probe:{ready:true}}),'');
  assert.equal(await next,'原生接口已就绪。');
  assert.equal(f.status(),null);
});

test('background maintenance is visible and disables conflicting console controls until completion',async()=>{
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,
      classList:{toggle(){}},setAttribute(){},addEventListener(){},querySelectorAll:()=>[],
      querySelector:selector=>element(id+selector)});
    return elements.get(id);
  };
  let operation={label:'自动验收未知构建（最长约 17 分钟）',startedAt:new Date().toISOString()};
  const context={document:{hidden:false,getElementById:element,querySelector:element,querySelectorAll:()=>[]},
    setInterval(){},window:{scrollTo(){},bridge:{
      loginStartup:async()=>false,onMaximized(){},windowAction:async()=>false,
      queue:async()=>({messages:[]}),desktops:async()=>({apps:{},profiles:[]}),
      canaryWatch:async()=>({enabled:true,attempts:{}}),maintenance:async()=>operation,
    }}};
  vm.runInNewContext(fs.readFileSync(new URL('renderer.js',consoleRoot),'utf8')+
    '\nglobalThis.api={maintenanceStatus};',context);
  await new Promise(setImmediate);
  assert.match(element('maintenance-status').textContent,/自动验收未知构建/);
  assert.equal(element('maintenance-status').hidden,false);
  assert.match(element('packages').innerHTML,/disabled/);
  assert.equal(element('certify-formbutton').disabled,true);
  assert.equal(element('canary-watch').disabled,true);
  operation=null;
  await context.api.maintenanceStatus();
  assert.equal(element('maintenance-status').hidden,true);
  assert.doesNotMatch(element('packages').innerHTML,/disabled/);
  assert.equal(element('certify-formbutton').disabled,false);
  assert.equal(element('canary-watch').disabled,false);
});
