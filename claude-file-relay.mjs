import http from 'node:http';
import { bootstrap } from './claude-renderer.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lifecycle } from './claude-lifecycle.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const directory = path.resolve(process.argv[2] ?? path.join(root, 'runtime', 'claude-relay'));
fs.mkdirSync(directory, { recursive: true });
const credentialsFile = path.join(directory, 'connection.json');
const token = fs.existsSync(credentialsFile) ? JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).token : crypto.randomBytes(32).toString('hex');
const allowed = ['getSessionList', 'getSession', 'getTranscriptTail', 'getTranscriptPage', 'getDetectedProjects', 'getDefaultEffort', 'start', 'sendMessage', 'setModel', 'setEffort', 'warmSession', 'updateSession', 'mcpReconnect', 'stop'];
const heartbeat = path.join(directory, 'heartbeat.json');
const requestFile = path.join(directory, 'request.json');
const responseFile = path.join(directory, 'response.json');
let queue = Promise.resolve();
const mainTransport = JSON.parse(fs.readFileSync(path.join(root,'claude-attach-compatibility.json'),'utf8')).transport === 'main-renderer-rpc';
const connected = async () => {
  if(mainTransport){try{return (await lifecycle('status')).records.some(row=>row.attaches>0&&!row.error);}catch{return false;}}
  try { return Date.now() - fs.statSync(heartbeat).mtimeMs < 15000; } catch { return false; }
};
async function nativeCall(request) {
  if(mainTransport){
    const reply=await lifecycle('native',{payload:{nativeMethod:request.method,args:request.args,expiresAt:Date.now()+60000}});
    return reply.result;
  }
  if (!fs.existsSync(path.join(directory, 'controller.json'))) throw new Error('Claude native control session is not initialized');
  const id = crypto.randomUUID();
  const temporary = `${requestFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ id, token, method: request.method, args: request.args, expiresAt: Date.now() + 60000 }), { mode: 0o600 });
  fs.renameSync(temporary, requestFile);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const message = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      if (message.id === id) {
        if (message.error) throw new Error(message.error);
        return message.result;
      }
    } catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Claude native API timeout; mutation outcome unknown');
}
const server = http.createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Local bearer token required' });
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, connected: await connected(), transport: mainTransport?'native-main-renderer-rpc':'native-renderer-file-mailbox', pid: process.pid });
  if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'Unknown route' });
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!allowed.includes(request.method) || !Array.isArray(request.args)) return reply(400, { error: 'Unsupported native API method or arguments' });
    const operation = queue.then(() => nativeCall(request));
    queue = operation.catch(() => {});
    reply(200, { result: await operation });
  } catch (error) { reply(502, { error: error.message }); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43128, '127.0.0.1', resolve); });
fs.writeFileSync(credentialsFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:43128', token, pid: process.pid }, null, 2), { mode: 0o600 });

const relative = path.relative(root, directory).replaceAll('\\', '/');
const controllerFile = path.join(directory, 'controller.json');
const controllerId = fs.existsSync(controllerFile) ? JSON.parse(fs.readFileSync(controllerFile, 'utf8')).sessionId : null;
fs.writeFileSync(path.join(directory, 'bootstrap-files.js'), `(${bootstrap.toString()})(${JSON.stringify(root)},${JSON.stringify(relative)},${JSON.stringify(token)},${JSON.stringify(allowed)},${JSON.stringify(controllerId)})`, { mode: 0o600 });
console.log('Claude native file relay listening on 127.0.0.1:43128; bootstrap file generated locally');
