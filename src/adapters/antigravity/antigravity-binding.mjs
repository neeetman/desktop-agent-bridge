// Fallback identity binding between the Antigravity PreToolUse hook (which knows
// the conversation) and the shared stdio MCP server (which may not). Kept free of
// project imports: the installer copies it next to the hook into the plugin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value ?? null);

export function canonicalArguments(value) {
  let args = value;
  if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch {} }
  return crypto.createHash('sha256').update(canonical(args ?? {})).digest('hex');
}

// Consume the single hook record for this exact call. Two different chats issuing
// an identical call inside the window are ambiguous and bind to neither.
export function consumeBinding(directory, tool, args, {now = Date.now(), windowMs = 30000} = {}) {
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => name.endsWith('.json')); } catch { return null; }
  const digest = canonicalArguments(args), matches = [];
  for (const name of names) {
    const file = path.join(directory, name);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!(now - record.at <= windowMs)) { try { fs.rmSync(file, {force: true}); } catch {} continue; }
    if (record.tool === tool && record.digest === digest) matches.push({file, record});
  }
  if (!matches.length) return null;
  if (new Set(matches.map(match => match.record.conversationId)).size !== 1) return {ambiguous: true};
  const oldest = matches.sort((a, b) => a.record.at - b.record.at)[0];
  try { fs.rmSync(oldest.file); } catch { return null; }
  return {conversationId: oldest.record.conversationId, toolCallId: oldest.record.toolCallId};
}
