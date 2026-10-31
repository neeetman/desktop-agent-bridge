import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {withCapability} from './compatibility.mjs';
import { fileURLToPath } from 'node:url';
export async function codexMcp(method,params={}) {
  if(method==='status')return mcpWire(method,params);
  return withCapability('codex','mcp',selection=>mcpWire(method,{...params,binding:selection.binding,expiresAt:Date.now()+90000}));
}
export function mcpWire(method, params = {}) {
  const { token } = JSON.parse(fs.readFileSync(new URL('./runtime/connection.json', import.meta.url)));
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\codex-gui-bridge-mcp'); let data = '';
    socket.setTimeout(method==='status'?5000:90000, () => socket.destroy(new Error('MCP operation timed out; inspect before retrying a mutation')));
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ ...params, token, method }) + '\n'));
    socket.on('data', chunk => { data += chunk.toString('utf8'); const index = data.indexOf('\n'); if (index < 0) return; try { const result = JSON.parse(data.slice(0, index)); socket.end(); result?.error ? reject(Object.assign(new Error(result.error),{code:result.code,status:result.status})) : resolve(result); } catch (error) { reject(error); socket.destroy(); } });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await codexMcp(process.argv[2] ?? 'status', process.argv[3] ? JSON.parse(process.argv[3]) : {})));
