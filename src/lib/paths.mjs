import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const PROJECT_ROOT=fileURLToPath(new URL('../../',import.meta.url));
const layouts=new Map();
export function sourcePath(root,name,...parts){
  const manifest=path.join(root,'src/layout.json');let files={};
  if(fs.existsSync(manifest)){
    const stamp=fs.statSync(manifest).mtimeMs,cached=layouts.get(manifest);
    if(cached?.stamp===stamp)files=cached.files;
    else{const layout=JSON.parse(fs.readFileSync(manifest,'utf8'));if(layout.schemaVersion!==1)throw Error('Unsupported source layout');files=layout.files;layouts.set(manifest,{stamp,files});}
  }
  const result=path.resolve(root,files[name]??name,...parts),relative=path.relative(path.resolve(root),result);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Source path escapes the project root');
  return result;
}
export function projectURL(name=''){
  const url=pathToFileURL(sourcePath(PROJECT_ROOT,name));
  if((name===''||name.endsWith('/'))&&!url.href.endsWith('/'))url.href+='/';
  return url;
}
