import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWorker} from '../../src/compat/compatibility.mjs';

test('worker observations exclude recycled PIDs, including those reassigned to Node',()=>{
  const record={pid:123,at:'2026-11-04T03:00:00.040Z'};
  const owner={Name:'node.exe',ProcessId:123,Created:'2026-11-04T03:00:00.0399990Z'};
  assert.equal(verifyWorker(record,owner),true);
  assert.equal(verifyWorker(record,{...owner,Created:'2026-11-04T04:00:00Z'}),false);
  assert.equal(verifyWorker(record,{...owner,Name:'python.exe'}),false);
  assert.equal(verifyWorker(record,{...owner,ProcessId:124}),false);
  assert.equal(verifyWorker(record,undefined),false);
  assert.equal(verifyWorker({...record,at:null},owner),false);
});
