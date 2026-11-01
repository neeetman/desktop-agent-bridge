import {projectURL} from "../../src/lib/paths.mjs";
import test from 'node:test';
import {runningDesktopCandidates} from '../../src/supervisor/supervisor-policy.mjs';
test('installed updates do not hide the still-running old desktop, and new generations are discovered',()=>{
 const old='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__pkg\\app\\ChatGPT.exe',next='C:\\Program Files\\WindowsApps\\OpenAI.Codex_2_x64__pkg\\app\\ChatGPT.exe';
 const app={name:'codex',executable:old,installedExecutable:next};const rows=new Map([[1,{ProcessId:1,ExecutablePath:old,ParentProcessId:0}],[2,{ProcessId:2,ExecutablePath:old,ParentProcessId:1}]]);
 assert.equal(runningDesktopCandidates(app,rows).length,1);assert.equal(runningDesktopCandidates(app,rows)[0].ProcessId,1);
 rows.clear();rows.set(3,{ProcessId:3,ExecutablePath:next,ParentProcessId:0});assert.equal(runningDesktopCandidates(app,rows)[0].ProcessId,3);
});
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backoffMs,childEnvironment,matchesScript,shouldRecover,restoreAppState,installedDesktopExecutable} from '../../src/supervisor/supervisor-policy.mjs';
test('desktop update resolves the registered package, independent of saved version paths',()=>{
  const packages=[{Name:'Claude',InstallLocation:'C:\\Program Files\\WindowsApps\\Claude_4.29.0.0_x64__pzs8sxrjxfjjc'},{Name:'OpenAI.Codex',InstallLocation:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1023.6123.0_x64__2p2nqsd0c76g0'}];
  assert.match(installedDesktopExecutable('codex',packages),/26\.1023\.6123\.0.*app\\ChatGPT.exe$/);
  assert.match(installedDesktopExecutable('claude',packages),/4\.29\.0\.0.*app\\Claude.exe$/);
  assert.equal(installedDesktopExecutable('deepseek',packages),null);
  assert.equal(installedDesktopExecutable('codex',[]),null);
});
test('recovery uses bounded exponential delays and startup grace before hang recovery',()=>{
  assert.deepEqual([1,2,3,8].map(n=>backoffMs(n)),[1000,2000,4000,60000]);
  assert.equal(shouldRecover({alive:true,healthy:false,ageMs:30000,failures:50}),null);
  assert.equal(shouldRecover({alive:true,healthy:false,ageMs:100000,failures:2}),null);
  assert.equal(shouldRecover({alive:true,healthy:false,ageMs:100000,failures:3}),'unhealthy');
  assert.equal(shouldRecover({alive:true,healthy:true,ageMs:100000,failures:3}),null);
  assert.equal(shouldRecover({alive:false}),'missing');
});
test('restart never adopts or terminates an unrelated PID; script identity has argument boundaries',()=>{
  const script=path.resolve('bridge-supervisor.mjs');
  assert.equal(matchesScript({CommandLine:`node "${script}"`},script),true);
  assert.equal(matchesScript({CommandLine:`node "${script}.unrelated"`},script),false);
  assert.equal(matchesScript({CommandLine:'node other.mjs'},script),false);
});
test('login children do not inherit stale session IDs or named pipes from an agent turn',()=>{
  const env=childEnvironment({CODEX_THREAD_ID:'stale',CODEX_APP_TOOLS_PIPE_PATH:'stale',CODEX_HOME:'home',CLAUDE_CODE_HOST_SESSION_ID:'stale',CLAUDE_CODE_SESSION_ID:'stale',PATH:'path',KEEP:'yes'},{});
  assert.equal(env.CODEX_THREAD_ID,undefined);assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH,undefined);
  assert.equal(env.CLAUDE_CODE_HOST_SESSION_ID,undefined);assert.equal(env.CODEX_HOME,'home');assert.equal(env.KEEP,'yes');
});
test('an explicit desktop exit stays closed during recovery but resets on the next Windows logon',()=>{
  const previous={claude:{pid:null,closedByUser:true,lastExitCode:0}};
  assert.equal(restoreAppState('claude',{},previous,true).closedByUser,true);
  assert.equal(restoreAppState('claude',{},previous,true).launchAtLogin,false);
  assert.equal(restoreAppState('claude',{},previous,false).closedByUser,false);
  assert.equal(restoreAppState('claude',{},previous,false).launchAtLogin,true);
});
test('Windows process watcher distinguishes normal desktop exit from crash exit',{skip:process.platform!=='win32'},async()=>{
  const first=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2500)'],{windowsHide:true,stdio:'ignore'});
  const second=spawn(process.execPath,['-e','setTimeout(()=>process.exit(7),2800)'],{windowsHide:true,stdio:'ignore'});
  const watcher=spawn('python',[fileURLToPath(projectURL("app-exit-watch.py")),JSON.stringify({codex:first.pid,claude:second.pid})],{windowsHide:true});
  let output='',errors='';watcher.stdout.on('data',chunk=>output+=chunk);watcher.stderr.on('data',chunk=>errors+=chunk);
  const code=await new Promise((resolve,reject)=>{watcher.on('error',reject);watcher.on('exit',resolve);});
  assert.equal(code,0,errors);
  const rows=output.trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(row=>row.app==='codex').clean,true);
  assert.equal(rows.find(row=>row.app==='claude').clean,false);
});
