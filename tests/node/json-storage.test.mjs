import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceFile, writeJson, readJson } from '../../src/lib/json-storage.mjs';
import { PeerRouter } from '../../src/mcp/peer-router.mjs';

const refusal = code => Object.assign(new Error(code), { code });

test('a transient Windows replace refusal is retried with backoff, then succeeds', () => {
  const waits = [];
  let calls = 0;
  const attempts = replaceFile('a.tmp', 'a', { sleep: ms => waits.push(ms), rename: () => { if (++calls < 3) throw refusal('EPERM'); } });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('a persistent refusal gives up after the attempt budget; other errors are not retried', () => {
  let calls = 0;
  assert.throws(() => replaceFile('a.tmp', 'a', { attempts: 4, sleep: () => {}, rename: () => { calls++; throw refusal('EBUSY'); } }), { code: 'EBUSY' });
  assert.equal(calls, 4);
  calls = 0;
  assert.throws(() => replaceFile('a.tmp', 'a', { sleep: () => {}, rename: () => { calls++; throw refusal('ENOENT'); } }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('a failed write leaves neither a temporary file nor a changed target', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'json-storage-'));
  try {
    const file = path.join(directory, 'state.json');
    writeJson(file, { version: 1 });
    assert.throws(() => writeJson(file, { version: 2 }, { attempts: 2, sleep: () => {}, rename: () => { throw refusal('EPERM'); } }), { code: 'EPERM' });
    assert.deepEqual(readJson(file), { version: 1 });
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a router whose state cannot be saved keeps running and retries later', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-save-'));
  const router = new PeerRouter({ directory, backendRequest: async () => ({}), pollMs: 1e9 });
  const original = fs.renameSync;
  try {
    fs.renameSync = () => { throw refusal('EPERM'); };
    assert.doesNotThrow(() => router.save());
    assert.equal(router.saveFailure.code, 'EPERM');
    fs.renameSync = original;
    router.save();
    assert.equal(router.saveFailure, null);
  } finally { fs.renameSync = original; clearTimeout(router.saveRetry); router.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
