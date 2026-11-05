import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeQueue} from '../../src/core/native-queue.mjs';

test('native inputs overtake only unstarted reads; writes remain ordered and are never replayed',async()=>{
 const q=new NativeQueue(),order=[];let release;
 const first=q.enqueue(()=>new Promise(resolve=>{release=resolve;order.push('active');}));
 const read=q.enqueue(async()=>order.push('read'));
 const write=q.enqueue(async()=>{order.push('write');throw Error('unknown native outcome');},{priority:true});
 const rejected=assert.rejects(write,/unknown native outcome/);
 const next=q.enqueue(async()=>order.push('next-write'),{priority:true});
 release();await Promise.all([first,read,rejected,next]);
 assert.deepEqual(order,['active','write','next-write','read']);
});
test('expired and disconnected queued requests cannot execute later',async()=>{
 let now=0,release,calls=0;const q=new NativeQueue({now:()=>now});
 const first=q.enqueue(()=>new Promise(resolve=>release=resolve));
 const expired=assert.rejects(q.enqueue(async()=>calls++,{priority:true,expiresAt:1000}),e=>e.dispatchNotStarted&&e.code==='NATIVE_QUEUE_EXPIRED');
 const cancelled=assert.rejects(q.enqueue(async()=>calls++,{priority:true,cancelled:()=>true}),e=>e.dispatchNotStarted);
 now=1001;release();await Promise.all([first,expired,cancelled]);assert.equal(calls,0);
});
test('a queue deadline replies before an unrelated stalled operation finishes',async()=>{
 const q=new NativeQueue();let release,calls=0;
 const first=q.enqueue(()=>new Promise(resolve=>release=resolve));
 try{await assert.rejects(q.enqueue(async()=>calls++,{expiresAt:Date.now()+20}),e=>e.dispatchNotStarted);assert.equal(calls,0);}
 finally{release();await first;}
});
