import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import policy from './execution-policy.cjs';
const run=promisify(execFile);
const git=async(args)=>(await run('git',args,{windowsHide:true,timeout:10000,maxBuffer:2*1024*1024})).stdout;
const equal=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export async function registeredLocation(projects,cwd,projectId,readGit=git){
 const real=policy.canonicalDirectory(cwd),candidates=projects.filter(p=>p.path&&(p.hostId??'local')==='local'&&(!projectId||p.projectId===projectId));
 for(const p of candidates){let base;try{base=policy.canonicalDirectory(p.path);}catch{continue;}if(equal(real,base))return {cwd:real,registeredRoot:base,projectId:p.projectId,isWorktree:false};}
 for(const p of candidates.filter(p=>p.isGitRepository)){
  try{const base=policy.canonicalDirectory(p.path),listed=await readGit(['-C',base,'worktree','list','--porcelain','-z']);
   if(!listed.split('\0').some(row=>{try{return row.startsWith('worktree ')&&equal(policy.canonicalDirectory(row.slice(9)),real);}catch{return false;}}))continue;
   const common=policy.canonicalDirectory((await readGit(['-C',base,'rev-parse','--path-format=absolute','--git-common-dir'])).trim()),actual=policy.canonicalDirectory((await readGit(['-C',real,'rev-parse','--path-format=absolute','--git-common-dir'])).trim());
   if(equal(common,actual))return {cwd:real,registeredRoot:base,projectId:p.projectId,isWorktree:true,gitCommonDir:common};
  }catch{}
 }
 throw Object.assign(new Error(`cwd ${cwd} is neither a registered project nor a verified git worktree of the selected registered repository; no session was created`),{status:400,code:'CWD_NOT_REGISTERED'});
}
