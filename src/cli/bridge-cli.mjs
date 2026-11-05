import {sourcePath} from "../lib/paths.mjs";
import {coordinator,compatError,ROOT} from '../compat/compatibility.mjs';
import {activateProfile,helperStatus} from '../compat/native-management.mjs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {codexMcp} from '../adapters/codex/codex-mcp-control.mjs';
import {lifecycle} from '../adapters/claude/claude-lifecycle.mjs';
import fs from 'node:fs';
import {setupCaller,removeCaller,listCallers,createTaskAsScript} from '../mcp/script-callers.mjs';
const option=(args,name)=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const options=(args,name)=>args.flatMap((arg,index)=>arg===name&&args[index+1]!==undefined?[args[index+1]]:[]);
const required=(args,name)=>{const value=option(args,name);if(value===undefined||value.startsWith('--'))throw compatError('INVALID_ARGUMENT',`${name} is required`,{status:400});return value;};
// Script callers: credential setup and the narrow task-creation entry for local
// scheduled scripts. The token is never accepted on the command line.
export async function scriptCommand(args,{routerDirectory=sourcePath(ROOT,'runtime/router'),env=process.env}={}){
 if(args[0]==='script-caller'){
  if(args[1]==='setup')return setupCaller({routerDirectory,env,name:required(args,'--name'),projects:options(args,'--project'),maxTasksPerHour:required(args,'--max-per-hour'),authorization:required(args,'--authorization'),toApp:option(args,'--to-app')??'claude',rotate:args.includes('--rotate')});
  if(args[1]==='list')return listCallers(routerDirectory);
  if(args[1]==='remove')return removeCaller({routerDirectory,env,name:required(args,'--name')});
  throw compatError('INVALID_ARGUMENT','Unknown script-caller command',{status:400});
 }
 if(args[0]==='script'&&args[1]==='create-task'){
  const prompt=fs.readFileSync(required(args,'--prompt-file'),'utf8').replace(/^﻿/,'');
  return createTaskAsScript({routerDirectory,env,name:required(args,'--caller'),title:required(args,'--title'),prompt,idempotencyKey:required(args,'--idempotency-key'),projectId:option(args,'--project'),model:option(args,'--model'),effort:option(args,'--effort'),taskVersion:option(args,'--task-version')});
 }
 throw compatError('INVALID_ARGUMENT','Unknown script command',{status:400});
}
export async function refreshClaudeMcp(thread,server='desktop-bridge',request=lifecycle){
 if(!thread||thread.startsWith('--')||!server||server.startsWith('--'))throw compatError('INVALID_ARGUMENT','Claude refresh requires --thread with an exact idle session ID and --server with an MCP server name');
 const nativeResult=await request('native',{payload:{nativeMethod:'mcpReconnect',args:[thread,server]}});
 if(nativeResult.result?.error)throw compatError('NATIVE_RECONNECT_FAILED',nativeResult.result.error);
 if(nativeResult.result?.queued)return {requested:true,deferred:true,nativeResult,workerVerificationRequired:true};
 return {requested:true,nativeResult,workerVerificationRequired:true};
}
export async function main(args){
 try{
  let result;const app=option(args,'--app');
  if(app&&!['codex','claude'].includes(app))throw compatError('INVALID_ARGUMENT','--app must be codex or claude');
  if(args[0]==='console'){
   const {default:electron}=await import('electron').catch(()=>{throw Error('Install the optional Electron dependency to open the console.');});
   const env={...process.env, DESKTOP_BRIDGE_NODE:process.execPath};
   delete env.ELECTRON_RUN_AS_NODE;
   const child=spawn(electron,[path.join(ROOT,'src','console','main.cjs')],{stdio:'inherit',env,windowsHide:true});
   process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
   return;
  }else if(args[0]==='doctor'){
   result=await coordinator.doctor(app);
   if(args.includes('--probe')){
    if(!app)throw compatError('INVALID_ARGUMENT','--probe requires --app');
    const kind=app==='claude'?'claude':result.apps.codex?.capabilities?.some(c=>['create','execution'].includes(c))?'execution':'messaging';
    const selected=await coordinator.resolve(app,kind==='execution'?'execution':'read');
    result.probe=await helperStatus(selected,kind);result.passive=false;
   }
  }else if(args[0]==='compat'){
   if(args[1]==='list')result={profiles:coordinator.profiles().map(({profile})=>({id:profile.id,app:profile.app,version:profile.packageVersion,revoked:profile.revoked,adapterDigest:profile.adapterDigest,capabilities:profile.capabilities}))};
   else if(args[1]==='import'){if(!args[2])throw compatError('INVALID_ARGUMENT','A local package directory is required');result=await coordinator.importPackage(args[2]);}
   else {
    if(!app)throw compatError('INVALID_ARGUMENT','--app is required');
    const id=option(args,'--profile');
    if(args[1]==='discover'){
      const {discover}=await import('../compat/discover.mjs');
      const {folder,contract,profile}=await discover(app);
      result={stage:'candidate',folder,contract,profileId:profile.id};
    }else if(args[1]==='certify'){
      const {certify}=await import('../compat/certify.mjs');
      result=await certify(app,{codex:option(args,'--codex-thread'),claude:option(args,'--claude-thread')});
    }else if(args[1]==='plan')result=await coordinator.plan(app,id);
    else if(args[1]==='activate'){if(!id||!args.includes('--when-idle'))throw compatError('INVALID_ARGUMENT','activate requires --profile and --when-idle');result=await activateProfile(app,id);}
    else if(args[1]==='rollback'){const previous=coordinator.state().apps[app]?.previousProfileId;if(!previous)throw compatError('NO_ROLLBACK','No previous profile is recorded');result=await activateProfile(app,previous);}
    else if(args[1]==='recover')result=await coordinator.recover(app);
    else if(args[1]==='refresh-mcp'){if(app==='codex')result=await codexMcp('reload');else result=await refreshClaudeMcp(option(args,'--thread'),option(args,'--server')??'desktop-bridge');}
    else throw compatError('INVALID_ARGUMENT','Unknown compat command');
   }
  }else if(args[0]==='script-caller'||args[0]==='script'){
   result=await scriptCommand(args);
  }else if(args[0]==='install'){
   if(process.platform!=='win32')throw compatError('UNSUPPORTED_PLATFORM','Desktop installation requires Windows');
   const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',sourcePath(ROOT,'install.ps1'),...args.slice(1)],{stdio:'inherit',windowsHide:true});process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});return;
  }else result={name:'@neeetman/desktop-agent-bridge',commands:['console','doctor [--app codex|claude] [--probe]','compat list','compat discover --app <app>','compat certify --app <app> --codex-thread <uuid> --claude-thread <local_uuid>','compat import <local-directory>','compat plan --app <app> [--profile <id>]','compat activate --app <app> --profile <id> --when-idle','compat rollback --app <app>','compat recover --app <app>','install <PowerShell installer arguments>','script-caller setup --name <name> --project <abs-path> [--project ...] --max-per-hour <n> --authorization <owner statement> [--rotate]','script-caller list','script-caller remove --name <name>','script create-task --caller <name> --title <title> --prompt-file <file> --idempotency-key <key> [--project <abs-path>] [--model <id>] [--effort <level>]']};
  console.log(JSON.stringify(result,null,2));
 }catch(error){console.error(JSON.stringify({error:error.message,code:error.code??'BRIDGE_ERROR',dispatchNotStarted:error.dispatchNotStarted??false,...(error.status?{httpStatus:error.status}:{}),...(error.retryAfterSeconds?{retryAfterSeconds:error.retryAfterSeconds}:{})}));process.exitCode=1;}
}
