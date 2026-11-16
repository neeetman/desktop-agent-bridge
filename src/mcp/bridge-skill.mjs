import {projectURL,sourcePath} from "../lib/paths.mjs";
// The desktop-bridge skill carries the communication guide that used to be
// appended to every bridged message. Installers in scripts/install/bridge_skill.py
// write the same layout; this module only reads it (router fallback, console).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(projectURL(''));
export const SKILL_NAME='desktop-bridge';
export const SKILL_MARKER='.desktop-bridge-skill.json';
// Codex and DeepSeek Harness both read the shared user skill root ~/.agents/skills.
export const APP_SKILL_TARGET={claude:'claude',codex:'agents',deepseek:'agents',antigravity:'antigravity'};

export const skillSource=(root=ROOT)=>sourcePath(root,'desktop-bridge-skill.md');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
export const skillRevision=(root=ROOT)=>sha(fs.readFileSync(skillSource(root))).slice(0,16);
export function skillGuide(root=ROOT){
  return fs.readFileSync(skillSource(root),'utf8').replace(/^---\n[\s\S]*?\n---\n+/,'');
}
export function skillTargets(home=os.homedir(),env=process.env){
  const claudeHome=env.CLAUDE_CONFIG_DIR||path.join(home,'.claude');
  return {
    claude:path.join(claudeHome,'skills',SKILL_NAME),
    agents:path.join(home,'.agents','skills',SKILL_NAME),
    antigravity:path.join(home,'.gemini','config','plugins','desktop-agent-bridge','skills',SKILL_NAME),
  };
}
// missing | unmanaged (someone else's skill of that name) | modified (edited after install)
// | outdated (older repo revision) | current
export function skillStatus(directory,revision){
  const skill=path.join(directory,'SKILL.md');
  if(!fs.existsSync(skill))return {state:'missing',path:directory,installedRevision:null};
  let marker;
  try{marker=JSON.parse(fs.readFileSync(path.join(directory,SKILL_MARKER),'utf8'));}catch{return {state:'unmanaged',path:directory,installedRevision:null};}
  if(marker?.managedBy!=='desktop-agent-bridge')return {state:'unmanaged',path:directory,installedRevision:null};
  const installedRevision=marker.revision??null;
  if(sha(fs.readFileSync(skill))!==marker.sha256)return {state:'modified',path:directory,installedRevision,installedAt:marker.installedAt??null};
  return {state:installedRevision===revision?'current':'outdated',path:directory,installedRevision,installedAt:marker.installedAt??null};
}
// Router lookup: one short-lived cache entry per target keeps per-delivery cost low.
export function skillLookup({root=ROOT,home=os.homedir(),env=process.env,ttlMs=10000,now=Date.now}={}){
  const cache=new Map();
  return app=>{
    const key=APP_SKILL_TARGET[app];if(!key)return {state:'unsupported'};
    const hit=cache.get(key);if(hit&&now()-hit.at<ttlMs)return hit.value;
    let value;try{value=skillStatus(skillTargets(home,env)[key],skillRevision(root));}catch(error){value={state:'error',error:error.message};}
    cache.set(key,{at:now(),value});return value;
  };
}
