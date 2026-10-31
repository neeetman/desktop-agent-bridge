const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const directory=()=>path.join(os.homedir(),'.desktop-session-bridge');
const settingsFile=()=>path.join(directory(),'settings.json');
const threadsFile=()=>path.join(directory(),'threads.json');
const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===403?'WRITABLE_ROOT_NOT_ALLOWED':'INVALID_EXECUTION_POLICY'});
function canonicalDirectory(value){
 if(typeof value!=='string'||!path.isAbsolute(value)||/^(?:\\\\\.\\|\\\\\?\\GLOBALROOT)/i.test(value))throw fail('Execution paths must be absolute directories');
 let real;try{real=fs.realpathSync.native(value);if(!fs.statSync(real).isDirectory())throw Error();}catch{throw fail(`Directory does not exist: ${value}`);}
 return real;
}
function within(child,parent){const relative=path.relative(parent.toLowerCase(),child.toLowerCase());return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}
function readSettings(){const value=JSON.parse(fs.readFileSync(settingsFile(),'utf8'));if(!Array.isArray(value.allowedWritableRoots))throw fail('Local allowedWritableRoots is not configured',503);return value;}
function validate(input,settings=readSettings()){
 if(input.allowedWritableRoots!==undefined)throw fail('allowedWritableRoots is local operator configuration; peer requests cannot change it',403);
 const sandboxMode=input.sandboxMode??settings.defaultSandboxMode??'workspace-write',approvalPolicy=input.approvalPolicy??(sandboxMode==='danger-full-access'?'never':settings.defaultApprovalPolicy??'on-request');
 if(!['workspace-write','read-only','danger-full-access'].includes(sandboxMode))throw fail('Unsupported sandboxMode',400);
 if(!['on-request','untrusted','never','on-failure'].includes(approvalPolicy))throw fail('Unsupported approvalPolicy');
 const requested=input.writableRoots??[];if(!Array.isArray(requested)||requested.length>32)throw fail('writableRoots must be an absolute directory array (up to 32 entries)');
 if(sandboxMode==='danger-full-access'){if(requested.length)throw fail('Full access cannot be restricted by writableRoots; omit writableRoots');return {sandboxMode,writableRoots:[],approvalPolicy};}
 const allowed=settings.allowedWritableRoots.map(canonicalDirectory),roots=[...new Set(requested.map(canonicalDirectory))];
 for(const root of roots)if(within(directory(),root))throw fail('A writable root cannot contain the bridge operator configuration directory',403);
 for(const root of roots)if(!allowed.some(base=>within(root,base)))throw fail(`writableRoots denied: ${root} is outside the locally configured allowedWritableRoots`,403);
 if(sandboxMode==='read-only'&&roots.length)throw fail('read-only cannot grant writableRoots');
 return {sandboxMode,writableRoots:roots,approvalPolicy};
}
function nativePermissions(policy,cwd){return {activePermissionProfile:null,runtimeWorkspaceRoots:[cwd],approvalPolicy:policy.approvalPolicy,approvalsReviewer:'user',sandboxPolicy:policy.sandboxMode==='danger-full-access'?{type:'dangerFullAccess'}:policy.sandboxMode==='read-only'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[...new Set([cwd,...policy.writableRoots])],networkAccess:false,excludeSlashTmp:false,excludeTmpdirEnvVar:false}};}
function nativeConfig(policy){return {sandbox_mode:policy.sandboxMode,approval_policy:policy.approvalPolicy,...policy.sandboxMode==='workspace-write'?{sandbox_workspace_write:{writable_roots:policy.writableRoots,network_access:false,exclude_slash_tmp:false,exclude_tmpdir_env_var:false}}:{}};}
function describePermissions(sandbox,approvalPolicy){return {sandboxMode:({workspaceWrite:'workspace-write',readOnly:'read-only',dangerFullAccess:'danger-full-access','workspace-write':'workspace-write','read-only':'read-only','danger-full-access':'danger-full-access'})[sandbox?.type]??null,writableRoots:sandbox?.writableRoots??sandbox?.writable_roots??[],approvalPolicy:approvalPolicy??null};}
function loadState(){try{return JSON.parse(fs.readFileSync(threadsFile(),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {threads:{},requests:{}};}}
function saveState(state){fs.mkdirSync(directory(),{recursive:true});const tmp=threadsFile()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(tmp,threadsFile());}
module.exports={directory,settingsFile,threadsFile,canonicalDirectory,within,readSettings,validate,nativePermissions,nativeConfig,describePermissions,loadState,saveState,fail};
