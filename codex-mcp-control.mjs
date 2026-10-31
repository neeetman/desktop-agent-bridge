import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function codexMcp(method, params = {}) {
  const { token } = JSON.parse(fs.readFileSync(new URL('./runtime/connection.json', import.meta.url)));
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\codex-gui-bridge-mcp'); let data = '';
    socket.setTimeout(90000, () => socket.destroy(new Error('MCP operation timed out; inspect before retrying a mutation')));
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ ...params, token, method }) + '\n'));
    socket.on('data', chunk => { data += chunk.toString('utf8'); const index = data.indexOf('\n'); if (index < 0) return; try { const result = JSON.parse(data.slice(0, index)); socket.end(); result?.error ? reject(new Error(result.error)) : resolve(result); } catch (error) { reject(error); socket.destroy(); } });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await codexMcp(process.argv[2] ?? 'status', process.argv[3] ? JSON.parse(process.argv[3]) : {})));
