import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file, fallback) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw invalidJson(file);
  }
}

export function invalidJson(file) {
  // JSON.parse errors can quote fragments of credentials or chat content.
  return Object.assign(new Error(`Invalid JSON in ${file}. Restore a verified copy before retrying.`), {
    code: 'STATE_JSON_INVALID',
    status: 503,
    dispatchNotStarted: true,
  });
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    // Atomic replacement alone can publish a filename before its contents
    // survive an unexpected shutdown.
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx', mode: 0o600, flush: true,
    });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
