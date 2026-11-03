import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceProcess} from '../../src/supervisor/supervisor-policy.mjs';
test('supervisor follows the verified heartbeat worker instead of a persistent venv launcher',()=>{
 const script='D:/bridge/monitor.py';
 const launcher={ProcessId:10,CommandLine:'python D:/bridge/monitor.py'};
 const worker={ProcessId:11,CommandLine:'python D:/bridge/monitor.py'};
 const unrelated={ProcessId:12,CommandLine:'python D:/other/foreign.py'};
 const rows=new Map([[10,launcher],[11,worker],[12,unrelated]]);
 assert.equal(serviceProcess(rows,10,11,script),worker);
 assert.equal(serviceProcess(rows,10,12,script),launcher);
 assert.equal(serviceProcess(rows,10,11,script,11),launcher);
});
