// Optional Antigravity PreToolUse hook (fallback identity). Antigravity runs one
// stdio MCP server for all chats; current builds put the calling conversation in
// tools/call params._meta. When a build omits it, this hook records which
// conversation issued each desktop-bridge call so the MCP server can bind it.
//
// The hook must never break other tools: any failure still prints a decision.
// "ask" defers to the user's own permission settings (Always-Allow cache and
// presets); a missing decision would deny the tool call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalArguments} from './antigravity-binding.mjs';

const decision = JSON.stringify({decision: 'ask'});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const call = payload.toolCall ?? {};
    const server = String(call.args?.ServerName ?? '');
    const tool = String(call.args?.ToolName ?? '');
    const conversationId = payload.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID;
    if (call.name === 'call_mcp_tool' && /(^|_)desktop-bridge$/.test(server) && tool.startsWith('bridge_') && /^[0-9a-f-]{36}$/i.test(conversationId ?? '')) {
      const config = JSON.parse(fs.readFileSync(new URL('./hook-config.json', import.meta.url), 'utf8'));
      const directory = config.bindingsDirectory;
      fs.mkdirSync(directory, {recursive: true});
      const record = {conversationId, tool, digest: canonicalArguments(call.args?.Arguments), toolCallId: call.id ?? null, at: Date.now()};
      fs.writeFileSync(path.join(directory, `${record.at}-${crypto.randomBytes(6).toString('hex')}.json`), JSON.stringify(record), {mode: 0o600});
    }
  } catch {}
  process.stdout.write(decision);
});
