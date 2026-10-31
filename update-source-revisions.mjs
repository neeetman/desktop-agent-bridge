// Refresh self-authored adapter digests only. Never learns or approves desktop hashes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,adapterDigest} from './compatibility.mjs';
const groups={
 'codex-execution-compatibility.json':['codex-main-execution.cjs','execution-policy.cjs','codex-runtime.cjs','helper-binding.cjs'],
 'codex-mcp-compatibility.json':['codex-main-mcp.cjs','codex-runtime.cjs','helper-binding.cjs'],
};
for(const [file,names] of Object.entries(groups)){
 const value=JSON.parse(fs.readFileSync(path.join(ROOT,file)));value.helperRevision=crypto.createHash('sha256').update(Buffer.concat(names.map(name=>fs.readFileSync(path.join(ROOT,name))))).digest('hex').slice(0,16);fs.writeFileSync(path.join(ROOT,file),JSON.stringify(value,null,2)+'\n');
}
const read=name=>JSON.parse(fs.readFileSync(path.join(ROOT,name)));
const definitions=[
 {app:'codex',id:'codex-26.1027.3384.0-v1',packageVersion:'26.1027.3384.0',capabilities:['read','send','settings','execution','mcp'],adapterFiles:['codex-main-execution.cjs','codex-main-mcp.cjs','codex-runtime.cjs','execution-policy.cjs','helper-binding.cjs','claude-attach-agent.js'],manifests:{execution:read('codex-execution-compatibility.json'),mcp:read('codex-mcp-compatibility.json')}},
 {app:'claude',id:'claude-4.29.0-v1',packageVersion:'4.29.0',capabilities:['read','send','identity'],adapterFiles:['claude-main-attach.cjs','claude-renderer.mjs','helper-binding.cjs','claude-attach-agent.js'],manifests:{claude:read('claude-attach-compatibility.json')}},
];
const profileFiles=[];
for(const item of definitions){
 item.id=item.app+'-'+item.packageVersion+'-'+crypto.createHash('sha256').update(JSON.stringify({adapter:adapterDigest(ROOT,item.adapterFiles),manifests:item.manifests})).digest('hex').slice(0,16);
 const manifest=Object.values(item.manifests)[0];const profile={schemaVersion:1,coreApiVersion:1,platform:'win32',arch:'x64',...item,hashes:Object.fromEntries(Object.entries(manifest).filter(([key])=>key.endsWith('Sha256'))),adapterDigest:adapterDigest(ROOT,item.adapterFiles),revoked:false,evidence:{baseline:'v0.7 desktop contract; v0.8 coordinator offline tests',liveUpdateValidation:false}};
 const directory=path.join(ROOT,'compat',item.app);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,item.id+'.json'),JSON.stringify(profile,null,2)+'\n');
 profileFiles.push('compat/'+item.app+'/'+item.id+'.json');
}
fs.writeFileSync(path.join(ROOT,'compat/catalog.json'),JSON.stringify({schemaVersion:1,profiles:profileFiles},null,2)+'\n');
console.log('Source revisions refreshed; desktop hashes unchanged.');
