import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function lifecycle(method, { pipe = '\\\\.\\pipe\\claude-gui-bridge-control', connectionFile = fileURLToPath(new URL('./runtime/claude-relay/connection.json', import.meta.url)), payload = {} } = {}) {
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
      try { const result = JSON.parse(data.slice(0, index)); socket.end(); if (result.error) reject(new Error(result.error)); else resolve(result); }
      catch (error) { reject(error); socket.destroy(); }
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const method = process.argv[2] ?? 'status';
  if (!['status', 'reload', 'quit'].includes(method)) throw new Error('Expected status, reload or quit');
  console.log(JSON.stringify(await lifecycle(method)));
}
