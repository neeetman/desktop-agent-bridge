import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('MCP metadata identifies the current chat and cannot be overridden by a different supplied source', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./peer-client.mjs', import.meta.url))], { windowsHide: true });
  let output = ''; child.stdout.on('data', data => output += data);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'codex-mcp-client', version: 'test' }, capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_self', arguments: {}, _meta: { threadId: 'current-chat' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bridge_self', arguments: { fromThreadId: 'another-chat' }, _meta: { threadId: 'current-chat' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bridge_self', arguments: {}, _meta: { threadId: 'second-chat' } } },
  ];
  child.stdin.end(messages.map(JSON.stringify).join('\n') + '\n');
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0);
  const results = output.trim().split('\n').map(JSON.parse);
  assert.equal(results.find(x=>x.id===2).result.tools.length, 20);
  const tools=results.find(x=>x.id===2).result.tools;assert.ok(tools.find(t=>t.name==='bridge_create_task').inputSchema.properties.sandboxMode.enum.includes('danger-full-access'));assert.ok(tools.some(t=>t.name==='bridge_set_permissions'));
  const identity = JSON.parse(results.find(x=>x.id===3).result.content[0].text);
  assert.equal(identity.threadId, 'current-chat'); assert.equal(identity.app, 'codex');
  const mismatch = results.find(x=>x.id===4).result;
  assert.equal(mismatch.isError, true); assert.match(mismatch.content[0].text, /disagrees/);
  assert.equal(JSON.parse(results.find(x=>x.id===5).result.content[0].text).threadId, 'second-chat');
});
