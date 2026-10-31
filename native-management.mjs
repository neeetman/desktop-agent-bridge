import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {ROOT,coordinator,sameBinding,compatError} from './compatibility.mjs';
import {executionWire} from './codex-execution.mjs';
import {mcpWire} from './codex-mcp-control.mjs';
import {lifecycleWire} from './claude-lifecycle.mjs';
export async function helperStatus(selection,kind){
 const value=selection.app==='claude'?await lifecycleWire('status'):kind==='execution'?await executionWire('status'):await mcpWire('status');
 if(!sameBinding(value.binding,selection.binding))throw compatError('IDENTITY_MISMATCH','Running helper belongs to a different installation or activation');
 const ready=selection.app==='claude'?value.records?.some(row=>row.attaches>0&&!row.error):kind==='execution'?value.ready:value.state==='connected';
 return {ready:!!ready,binding:value.binding,kind};
}
export async function idleProbe(previous,app){
 const params={binding:previous.binding,expiresAt:Date.now()+10000};
 return app==='claude'?lifecycleWire('maintenance',{payload:params}):executionWire('maintenance',params);
}
export async function attachProbe(selection){
 let python='python';try{python=JSON.parse(fs.readFileSync(path.join(ROOT,'runtime/supervisor/config.json'),'utf8')).python;}catch{}
 for(const kind of selection.app==='claude'?['claude']:['execution','mcp']){
  await new Promise((resolve,reject)=>{
   // Structured JSON on stdin preserves paths and avoids shell/argv quoting.
   const child=execFile(python,[path.join(ROOT,'native-attach.py'),kind],{windowsHide:true,timeout:60000,maxBuffer:1024*1024},(error,stdout)=>{try{const result=JSON.parse(stdout.trim().split('\n').at(-1));result.installed&&!error?resolve():reject(compatError(result.code??'ATTACHMENT_ERROR',result.error??'Attachment not confirmed'));}catch{reject(compatError('ATTACHMENT_ERROR','Native attachment failed; inspect update status'));}});child.stdin.end(JSON.stringify(selection));
  });
  let status;for(let n=0;n<20;n++){try{status=await helperStatus(selection,kind);}catch{status=null;}if(status?.ready)break;await new Promise(r=>setTimeout(r,250));}
  if(!status?.ready)throw compatError('NATIVE_CALLBACK_PENDING','Helper attached but native readiness is pending');
 }
 return {ready:true,binding:selection.binding};
}
export async function activateProfile(app,id){return coordinator.activate(app,id,{idleProbe:previous=>idleProbe(previous,app),attachProbe});}
