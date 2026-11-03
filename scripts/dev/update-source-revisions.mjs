import {sourcePath} from "../../src/lib/paths.mjs";
// Refresh self-authored adapter digests only. Never learns or approves desktop hashes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,adapterDigest} from '../../src/compat/compatibility.mjs';
const groups={
 'codex-execution-compatibility.json':['codex-main-execution.cjs','execution-policy.cjs','codex-runtime.cjs','helper-binding.cjs'],
 'codex-mcp-compatibility.json':['codex-main-mcp.cjs','codex-runtime.cjs','helper-binding.cjs'],
};
for(const [file,names] of Object.entries(groups)){
 const value=JSON.parse(fs.readFileSync(sourcePath(ROOT,file)));value.helperRevision=crypto.createHash('sha256').update(Buffer.concat(names.map(name=>fs.readFileSync(sourcePath(ROOT,name))))).digest('hex').slice(0,16);fs.writeFileSync(sourcePath(ROOT,file),JSON.stringify(value,null,2)+'\n');
}
const read=name=>JSON.parse(fs.readFileSync(sourcePath(ROOT,name)));
// Refresh every registered build; source maintenance must not discard newer profiles.
const catalog=read('compat/catalog.json');
const definitions=catalog.profiles.map(file=>{
 const profile=JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8'));
 for(const kind of ['execution','mcp'])if(profile.manifests[kind])profile.manifests[kind].helperRevision=read('codex-'+kind+'-compatibility.json').helperRevision;
 return profile;
});
const profileFiles=[];
for(const item of definitions){
 item.id=item.app+'-'+item.packageVersion+'-'+crypto.createHash('sha256').update(JSON.stringify({adapter:adapterDigest(ROOT,item.adapterFiles),manifests:item.manifests})).digest('hex').slice(0,16);
 const previousDigest=item.adapterDigest;
 const manifest=Object.values(item.manifests)[0];const profile={schemaVersion:1,coreApiVersion:1,platform:'win32',arch:'x64',...item,hashes:Object.fromEntries(Object.entries(manifest).filter(([key])=>key.endsWith('Sha256'))),adapterDigest:adapterDigest(ROOT,item.adapterFiles),revoked:item.revoked??false,evidence:{...item.evidence,...(previousDigest!==adapterDigest(ROOT,item.adapterFiles)?{liveUpdateValidation:false}: {})}};
 const directory=sourcePath(ROOT,'compat',item.app);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,item.id+'.json'),JSON.stringify(profile,null,2)+'\n');
 profileFiles.push('compat/'+item.app+'/'+item.id+'.json');
}
fs.writeFileSync(sourcePath(ROOT,'compat/catalog.json'),JSON.stringify({schemaVersion:1,profiles:profileFiles},null,2)+'\n');
console.log('Source revisions refreshed; desktop hashes unchanged.');
