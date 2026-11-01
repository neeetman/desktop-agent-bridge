import {projectURL} from "../../lib/paths.mjs";
import fs from 'node:fs';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {coordinator,withCapability,sameBinding,compatError} from '../../compat/compatibility.mjs';
const run=promisify(execFile);let attaching;
export async function ensureExecution(){
 const selection=await coordinator.resolve('codex','execution');
 try{const status=await executionRpc('status');if(sameBinding(status.binding,selection.binding)&&status.ready)return status;}catch{}
 if(!attaching)attaching=(async()=>{let python='python';try{python=JSON.parse(fs.readFileSync(projectURL("runtime/supervisor/config.json"),'utf8')).python;}catch{}try{await run(python,[fileURLToPath(projectURL("codex-execution-attach.py"))],{windowsHide:true,timeout:60000});}catch(error){let details;try{details=JSON.parse(error.stdout.trim().split('\n').at(-1));}catch{}throw compatError(details?.code??'ATTACHMENT_ERROR',details?.error??'Native execution attachment failed');}const status=await executionRpc('status');if(!sameBinding(status.binding,selection.binding)||!status.ready)throw compatError('IDENTITY_MISMATCH','Native helper binding/readiness was not confirmed');return status;})().finally(()=>attaching=null);
 return attaching;
}
export async function executionRpc(method,params={}){
 if(method==='status')return executionWire(method,params);
 return withCapability('codex','execution',selection=>executionWire(method,{...params,binding:selection.binding,expiresAt:Date.now()+90000}));
}
export async function executionWire(method,params={}){
 const {token}=JSON.parse(fs.readFileSync(projectURL("runtime/connection.json"),'utf8'));
 return new Promise((resolve,reject)=>{let data='',done=false;const socket=net.connect('\\\\.\\pipe\\codex-gui-bridge-execution');
  socket.setTimeout(['status','maintenance'].includes(method)?10000:90000,()=>socket.destroy(new Error('Native execution request timed out; inspect before retrying')));socket.on('error',reject);socket.on('close',()=>{if(!done)reject(new Error('Native execution pipe closed; operation outcome unknown'));});
  socket.on('connect',()=>socket.write(JSON.stringify({...params,method,token})+'\n'));
  socket.on('data',chunk=>{data+=chunk.toString('utf8');if(data.length>8*1024*1024)return socket.destroy(new Error('Execution response too large'));const index=data.indexOf('\n');if(index<0)return;done=true;try{const result=JSON.parse(data.slice(0,index));socket.end();if(result.error)reject(Object.assign(new Error(result.error),{status:result.status,code:result.code}));else resolve(result);}catch(e){socket.destroy();reject(e);}});
 });
}
