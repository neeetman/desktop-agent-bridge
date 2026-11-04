import {projectURL} from "../../lib/paths.mjs";
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {withCapability,compatError} from '../../compat/compatibility.mjs';
export async function lifecycle(method, options={}) {
  if(method==='status')return lifecycleWire(method,options);
  const capability=method==='native'?['start','sendMessage','setModel','setEffort','warmSession','updateSession','mcpReconnect','stop'].includes(options.payload?.nativeMethod)?'send':'read':'identity';
  return withCapability('claude',capability,selection=>{
    if(selection.profile.evidence.stage==='messaging-verified' && capability==='send' && options.payload.nativeMethod!=='sendMessage')
      throw compatError('CAPABILITY_UNSUPPORTED','This profile is validated for existing-chat messaging only');
    if(selection.profile.coreApiVersion===2 && capability==='send'){
      const required={start:'create',sendMessage:'send',mcpReconnect:'mcp'}[options.payload.nativeMethod];
      if(!required||!selection.profile.capabilities.includes(required)||(required==='mcp'&&options.payload.args?.[1]!=='desktop-bridge'))throw compatError('CAPABILITY_UNSUPPORTED','Native operation was not certified for this build');
    }
    return lifecycleWire(method,{...options,payload:{...options.payload,binding:selection.binding,expiresAt:Date.now()+60000}});
  });
}
export function lifecycleWire(method, { pipe = '\\\\.\\pipe\\claude-gui-bridge-control', connectionFile = fileURLToPath(projectURL("runtime/claude-relay/connection.json")), payload = {} } = {}) {
  const { token } = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe); let data = '';
    socket.setTimeout(method==='native'?65000:5000, () => socket.destroy(new Error('Claude lifecycle timeout; operation outcome may be unknown')));
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Claude lifecycle pipe closed; operation outcome may be unknown')));
    socket.on('connect', () => socket.write(JSON.stringify({ ...payload, token, method }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > (method==='native'?8*1024*1024:65536)) return socket.destroy(new Error('Lifecycle response too large'));
      const index = data.indexOf('\n'); if (index < 0) return;
      try { const result = JSON.parse(data.slice(0, index)); socket.end(); if (result.error) reject(Object.assign(new Error(result.error),{code:result.code,status:result.status})); else resolve(result); }
      catch (error) { reject(error); socket.destroy(); }
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const method = process.argv[2] ?? 'status';
  if (!['status', 'reload', 'quit'].includes(method)) throw new Error('Expected status, reload or quit');
  console.log(JSON.stringify(await lifecycle(method)));
}
