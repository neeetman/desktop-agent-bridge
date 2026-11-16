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

// Windows refuses to replace a file while another process (a reader, Defender,
// the search indexer) briefly holds it open. Retry those transient refusals
// with a short backoff before giving up; never leave the temporary file behind.
const TRANSIENT_REPLACE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = new Int32Array(new SharedArrayBuffer(4));
export function replaceFile(temporary, file, { attempts = 8, sleep = ms => Atomics.wait(pause, 0, 0, ms), rename = fs.renameSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(temporary, file);
      return attempt;
    } catch (error) {
      if (!TRANSIENT_REPLACE.has(error.code) || attempt >= attempts) throw error;
      sleep(Math.min(25 * 2 ** (attempt - 1), 400));
    }
  }
}

export function writeJson(file, value, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    // Atomic replacement alone can publish a filename before its contents
    // survive an unexpected shutdown.
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx', mode: 0o600, flush: true,
    });
    replaceFile(temporary, file, options);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
