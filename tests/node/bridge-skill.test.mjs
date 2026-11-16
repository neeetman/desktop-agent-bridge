import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {PeerRouter} from '../../src/mcp/peer-router.mjs';
import {skillGuide,skillLookup,skillRevision,skillSource,skillStatus,skillTargets,SKILL_MARKER} from '../../src/mcp/bridge-skill.mjs';

const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
function install(directory,{revision=skillRevision(),edit=false}={}){
  fs.mkdirSync(directory,{recursive:true});const data=fs.readFileSync(skillSource());
  fs.writeFileSync(path.join(directory,'SKILL.md'),edit?Buffer.concat([data,Buffer.from('\nlocal edit\n')]):data);
  fs.writeFileSync(path.join(directory,SKILL_MARKER),JSON.stringify({managedBy:'desktop-agent-bridge',revision,sha256:sha(data)}));
}

test('skill source has the frontmatter each harness needs and the guide body',()=>{
  const source=fs.readFileSync(skillSource(),'utf8');
  assert.match(source,/^---\nname: desktop-bridge\ndescription: .*\[bridge \{\.\.\.\}\].*bridge_\*/);
  const guide=skillGuide();assert.ok(!guide.startsWith('---'));
  for(const word of ['bridge_ack','bridge_reply','expectReply=false','bridge_answer_decision','bridge_request_decision','taskVersion'])assert.ok(guide.includes(word),word);
  assert.match(skillRevision(),/^[0-9a-f]{16}$/);
});
test('skill targets follow each harness discovery root',()=>{
  const home=path.join(os.tmpdir(),'home');const targets=skillTargets(home,{});
  assert.equal(targets.claude,path.join(home,'.claude','skills','desktop-bridge'));
  assert.equal(targets.agents,path.join(home,'.agents','skills','desktop-bridge'));
  assert.equal(targets.antigravity,path.join(home,'.gemini','config','plugins','desktop-agent-bridge','skills','desktop-bridge'));
  assert.equal(skillTargets(home,{CLAUDE_CONFIG_DIR:path.join(home,'cc')}).claude,path.join(home,'cc','skills','desktop-bridge'));
});
test('skill status detects missing, unmanaged, modified, outdated and current copies',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skill-'));try{
    const directory=path.join(base,'s'),revision=skillRevision();
    assert.equal(skillStatus(directory,revision).state,'missing');
    fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'SKILL.md'),'someone else');
    assert.equal(skillStatus(directory,revision).state,'unmanaged');
    install(directory);assert.equal(skillStatus(directory,revision).state,'current');
    install(directory,{revision:'0000000000000000'});assert.deepEqual([skillStatus(directory,revision).state,skillStatus(directory,revision).installedRevision],['outdated','0000000000000000']);
    install(directory,{edit:true});assert.equal(skillStatus(directory,revision).state,'modified');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('router drops the guide line only for apps whose skill copy is current',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skill-home-')),directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skill-router-'));
  let now=0;const router=new PeerRouter({directory,backendRequest:async()=>({}),pollMs:1e9,skillState:skillLookup({home,env:{},now:()=>now})});
  try{
    const from={app:'codex',threadId:'c1'},toClaude={app:'claude',threadId:'k1'},toDeepseek={app:'deepseek',threadId:'d1'};
    const missing=router.prompt({id:'m1',from,to:toClaude,text:'hello',expectReply:true});
    assert.match(missing,/桌面通信指南：/);
    const guide=fs.readFileSync(path.join(directory,'peer-guide-v2.md'),'utf8');assert.equal(guide,skillGuide());
    install(skillTargets(home,{}).claude);now+=60000;
    const current=router.prompt({id:'m2',from,to:toClaude,text:'hello',expectReply:true});
    assert.ok(current.startsWith('[bridge '));assert.ok(current.endsWith('hello'));assert.doesNotMatch(current,/桌面通信指南/);
    // Codex and DeepSeek share ~/.agents/skills; without it they keep the fallback.
    assert.match(router.prompt({id:'m3',from:toClaude,to:toDeepseek,text:'x',expectReply:false}),/桌面通信指南：/);
    install(skillTargets(home,{}).agents,{edit:true});now+=60000;
    assert.match(router.prompt({id:'m4',from:toClaude,to:toDeepseek,text:'x',expectReply:false}),/桌面通信指南：/);
  }finally{router.close();fs.rmSync(home,{recursive:true,force:true});fs.rmSync(directory,{recursive:true,force:true});}
});
