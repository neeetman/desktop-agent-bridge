import test from 'node:test';
import assert from 'node:assert/strict';
import {idleProbe} from '../../src/compat/native-management.mjs';

const previous={binding:{installationId:'i'}};
test('activation treats a missing previous execution helper as nothing to replace',async()=>{
 const missing=async()=>{throw Object.assign(Error('connect ENOENT \\\\.\\pipe\\codex-gui-bridge-execution'),{code:'ENOENT'});};
 assert.deepEqual(await idleProbe(previous,'codex',missing),{authoritative:true,idle:true,previousHelper:'absent'});
 assert.deepEqual(await idleProbe(previous,'claude',missing),{authoritative:true,idle:true,previousHelper:'absent'});
});
test('a running previous helper still decides idleness, and other failures still block',async()=>{
 const calls=[];
 assert.deepEqual(await idleProbe(previous,'codex',async(method,params)=>{calls.push([method,params.binding]);return {authoritative:true,idle:false};}),{authoritative:true,idle:false});
 assert.deepEqual(calls,[['maintenance',previous.binding]]);
 await assert.rejects(idleProbe(previous,'codex',async()=>{throw Object.assign(Error('busy'),{code:'REFRESH_DEFERRED_BUSY'});}),/busy/);
 await assert.rejects(idleProbe(previous,'codex',async()=>{throw Object.assign(Error('timed out'),{code:'ETIMEDOUT'});}),/timed out/);
});
