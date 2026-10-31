import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Compatibility,adapterDigest} from './compatibility.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const groups={
  'codex-execution-compatibility.json':['codex-main-execution.cjs','execution-policy.cjs','codex-runtime.cjs','helper-binding.cjs'],
  'codex-mcp-compatibility.json':['codex-main-mcp.cjs','codex-runtime.cjs','helper-binding.cjs'],
};
for(const [manifest,files] of Object.entries(groups)){
  const revision=crypto.createHash('sha256').update(Buffer.concat(files.map(file=>fs.readFileSync(path.join(root,file))))).digest('hex').slice(0,16);
  if(JSON.parse(fs.readFileSync(path.join(root,manifest),'utf8')).helperRevision!==revision)throw Error(`${manifest}: helperRevision must match ${files.join(', ')}`);
}
for(const file of fs.readdirSync(root).filter(name=>/\.(?:mjs|cjs|js)$/.test(name))){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+)['"]/g)){
    if(!fs.existsSync(path.join(root,match[1])))throw Error(`${file}: missing local dependency ${match[1]}`);
  }
}
for(const {profile,adapterRoot} of new Compatibility(root).profiles())if(adapterDigest(adapterRoot,profile.adapterFiles)!==profile.adapterDigest)throw Error('Profile adapter digest mismatch: '+profile.id);
console.log('Helper revisions, compatibility profiles and local JavaScript dependencies verified.');
