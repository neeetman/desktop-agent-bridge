import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PROJECT_ROOT,sourcePath,projectURL} from '../../src/lib/paths.mjs';

test('every logical production source resolves to the organized checkout',()=>{
  const layout=JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,'src/layout.json'),'utf8'));
  for(const [name,relative] of Object.entries(layout.files)){
    assert.equal(sourcePath(PROJECT_ROOT,name),path.resolve(PROJECT_ROOT,relative));
    assert.ok(fs.existsSync(sourcePath(PROJECT_ROOT,name)),name);
  }
  assert.ok(projectURL('runtime/router/').href.endsWith('/runtime/router/'));
  assert.throws(()=>sourcePath(PROJECT_ROOT,'../outside'),/escapes/);
});

test('immutable adapter bundles retain their flat logical file layout',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-flat-layout-'));
  try{fs.writeFileSync(path.join(directory,'helper-binding.cjs'),'fixture');assert.equal(sourcePath(directory,'helper-binding.cjs'),path.join(directory,'helper-binding.cjs'));}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
});
