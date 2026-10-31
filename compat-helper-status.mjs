import {helperStatus} from './native-management.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
try{const selected=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(JSON.stringify(await helperStatus(selected,selected.app==='codex'?'mcp':'claude')));}catch(error){process.stdout.write(JSON.stringify({ready:false,code:error.code,error:error.message}));}
