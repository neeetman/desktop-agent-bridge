import fs from 'node:fs';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);let attaching;
export async function ensureExecution(){
 const manifest=JSON.parse(fs.readFileSync(new URL('./codex-execution-compatibility.json',import.meta.url),'utf8'));
 try{const status=await executionRpc('status');if(status.revision===manifest.helperRevision&&status.ready)return status;}catch{}
 if(!attaching)attaching=(async()=>{const config=JSON.parse(fs.readFileSync(new URL('./runtime/supervisor/config.json',import.meta.url),'utf8'));await run(config.python,[fileURLToPath(new URL('./codex-execution-attach.py',import.meta.url))],{windowsHide:true,timeout:60000});const status=await executionRpc('status');if(status.revision!==manifest.helperRevision||!status.ready)throw new Error('Validated execution helper was not installed; no thread mutation was sent');return status;})().finally(()=>attaching=null);
 return attaching;
}
export async function executionRpc(method,params={}){
 const {token}=JSON.parse(fs.readFileSync(new URL('./runtime/connection.json',import.meta.url),'utf8'));
 return new Promise((resolve,reject)=>{let data='',done=false;const socket=net.connect('\\\\.\\pipe\\codex-gui-bridge-execution');
  socket.setTimeout(90000,()=>socket.destroy(new Error('Native execution request timed out; inspect before retrying')));socket.on('error',reject);socket.on('close',()=>{if(!done)reject(new Error('Native execution pipe closed; operation outcome unknown'));});
  socket.on('connect',()=>socket.write(JSON.stringify({...params,method,token})+'\n'));
  socket.on('data',chunk=>{data+=chunk.toString('utf8');if(data.length>8*1024*1024)return socket.destroy(new Error('Execution response too large'));const index=data.indexOf('\n');if(index<0)return;done=true;try{const result=JSON.parse(data.slice(0,index));socket.end();if(result.error)reject(Object.assign(new Error(result.error),{status:result.status,code:result.code}));else resolve(result);}catch(e){socket.destroy();reject(e);}});
 });
}
