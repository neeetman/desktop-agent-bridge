import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import policy from './execution-policy.cjs';
import {registeredLocation} from './worktree-location.mjs';
import {normalizeExecution} from './contracts.mjs';
import {startBridge} from './bridge.mjs';

test('execution roots are canonical, bounded, local-only and cannot contain policy files',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-policy-'));
 const allowed=path.join(base,'allowed'),outside=path.join(base,'allowed-extra');
 fs.mkdirSync(allowed);fs.mkdirSync(outside);
 const config={allowedWritableRoots:[allowed]};
 try{
  assert.deepEqual(policy.validate({writableRoots:[allowed]},config),{sandboxMode:'workspace-write',writableRoots:[fs.realpathSync.native(allowed)],approvalPolicy:'on-request'});
  for(const root of [outside,path.join(allowed,'..','allowed-extra')])assert.throws(()=>policy.validate({writableRoots:[root]},config),{status:403});
  assert.throws(()=>policy.validate({writableRoots:['relative']},config),/absolute/);
  assert.throws(()=>policy.validate({writableRoots:[path.join(base,'missing')]},config),/does not exist/);
  assert.throws(()=>policy.validate({allowedWritableRoots:[outside]},config),{status:403});
  const full=policy.validate({sandboxMode:'danger-full-access'},config);
  assert.deepEqual(full,{sandboxMode:'danger-full-access',writableRoots:[],approvalPolicy:'never'});
  assert.deepEqual(policy.nativePermissions(full,allowed).sandboxPolicy,{type:'dangerFullAccess'});
  assert.deepEqual(policy.nativeConfig(full),{sandbox_mode:'danger-full-access',approval_policy:'never'});
  assert.throws(()=>policy.validate({sandboxMode:'danger-full-access',writableRoots:[allowed]},config),/omit writableRoots/);
  assert.equal(normalizeExecution({sandboxMode:'danger-full-access'}).sandboxMode,'danger-full-access');
  assert.throws(()=>policy.validate({sandboxMode:'read-only',writableRoots:[allowed]},config),/read-only/);
  assert.equal(policy.validate({sandboxMode:'read-only'},config).sandboxMode,'read-only');
  const link=path.join(allowed,'escape');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>policy.validate({writableRoots:[link]},config),{status:403});
  fs.unlinkSync(link);
  assert.throws(()=>normalizeExecution({threadId:'t',writableRoots:[allowed]}),/retains/);
  assert.throws(()=>normalizeExecution({writableRoots:[allowed]},{allowExecutionPolicy:false}),/only supported by Codex/);
  assert.equal(policy.nativePermissions(policy.validate({},config),allowed).sandboxPolicy.networkAccess,false);
 }finally{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));fs.rmSync(base,{recursive:true,force:true});}
});

test('managed task metadata reports native policy fields and clears them when native readback fails',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-policy-http-'));let unavailable=false;
 const actual={sandboxMode:'workspace-write',writableRoots:['native-root'],approvalPolicy:'on-request',executionSource:'native-desktop-conversation-state'};
 const calls=[],tools={callerThread:'test',close(){},isExecutionManaged:id=>id==='managed',executionCapabilities:()=>({sandboxModes:['workspace-write','read-only']}),prepareExecution:async execution=>({...execution,executionPolicy:{sandboxMode:'workspace-write',writableRoots:['requested-root'],approvalPolicy:'on-request'}}),readSettings:async()=>{if(unavailable)throw Error('Native unavailable');return {settings:actual};},call:async(name,args)=>{calls.push({name,args});if(name==='create_thread')return {threadId:'managed'};if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:[]};throw Error('Unexpected mutation');}};
 const bridge=await startBridge({tools,stateDir,port:0,pollMs:60000,enableIpc:false});
 const request=async(route,body)=>{const r=await fetch(bridge.baseUrl+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();};
 try{
  const task=await request('/v1/tasks',{prompt:'authorized fixture',writableRoots:['requested-root']});
  assert.equal(calls.find(c=>c.name==='create_thread').args.executionPolicy.writableRoots[0],'requested-root');
  assert.equal(task.writableRoots[0],'native-root');assert.equal((await request(`/v1/tasks/${task.id}`)).approvalPolicy,'on-request');
  assert.ok((await request('/v1/capabilities')).executionFields.includes('writableRoots'));
  unavailable=true;const missing=await request(`/v1/tasks/${task.id}`);assert.equal(missing.writableRoots,null);assert.equal(missing.sandboxMode,null);assert.equal(missing.effectiveSettings,null);
 }finally{await bridge.close();assert.equal(path.dirname(stateDir),path.resolve(os.tmpdir()));fs.rmSync(stateDir,{recursive:true,force:true});}
});

test('cwd accepts only a registered directory or a real worktree with the same git common directory',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-worktree-')),repo=path.join(base,'repo'),wt=path.join(base,'wt'),other=path.join(base,'other');
 fs.mkdirSync(repo);fs.mkdirSync(other);
 const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{
  git(['init',repo]);git(['-C',repo,'-c','user.name=Bridge Test','-c','user.email=bridge@example.invalid','commit','--allow-empty','-m','fixture']);git(['-C',repo,'worktree','add','--detach',wt,'HEAD']);
  const projects=[{projectId:'p',path:repo,isGitRepository:true}];
  assert.equal((await registeredLocation(projects,repo)).isWorktree,false);
  assert.equal((await registeredLocation(projects,wt,'p')).isWorktree,true);
  await assert.rejects(registeredLocation(projects,other),{code:'CWD_NOT_REGISTERED'});
  await assert.rejects(registeredLocation(projects,wt,'different-project'),{code:'CWD_NOT_REGISTERED'});
  await assert.rejects(registeredLocation(projects,wt,'p',async args=>args.includes('worktree')?`worktree ${wt}\0\0`:fs.realpathSync.native(args[1])===fs.realpathSync.native(repo)?repo:other),{code:'CWD_NOT_REGISTERED'});
 }finally{try{git(['-C',repo,'worktree','remove','--force',wt]);}catch{}assert.equal(path.dirname(base),path.resolve(os.tmpdir()));fs.rmSync(base,{recursive:true,force:true});}
});
