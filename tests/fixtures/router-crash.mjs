import fs from 'node:fs';
import path from 'node:path';
import {startRouter} from '../../src/mcp/peer-router.mjs';
const directory=process.argv[2], accepted=path.join(directory,'accepted');
await startRouter({directory,port:0,async backendRequest(app,route,method){
  if(route.startsWith('/v1/events'))return {events:[],cursor:0};
  if(route.startsWith('/v1/dispatch-record'))return {taskId:'slow-task',status:'running'};
  if(method==='POST'&&app==='claude'){
    fs.appendFileSync(accepted,'1');await new Promise(()=>{});
  }
  if(method==='POST')return {id:'fast-task',status:'running'};
  if(route.startsWith('/v1/tasks/'))return {status:'running'};
  return {thread:{status:{type:'idle'}}};
}});
process.send('ready');
