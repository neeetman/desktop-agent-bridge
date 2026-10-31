const fs=require('node:fs'),path=require('node:path');
const same=(a,b)=>!!a&&!!b&&['installationId','root','credentialEpoch','generation','activationEpoch','profileDigest','adapterDigest'].every(key=>a[key]===b[key]);
const error=(code,message)=>Object.assign(Error(message),{code,status:503});
function createGuard(root,app,binding){
 if(!binding)throw error('IDENTITY_MISMATCH','Installation binding is required');
 function check(request,{probe=false}={}){
  if(!same(request.binding,binding))throw error('IDENTITY_MISMATCH','Native helper installation/generation binding mismatch');
  const state=JSON.parse(fs.readFileSync(path.join(root,'runtime/updates/state.json'),'utf8')),row=state.apps[app];
  if(!row)throw error('CONFIG_EPOCH_CHANGED','Compatibility state is unavailable');
  if(row.transition){if(!probe||!(same(row.transition.binding,binding)||row.transition.phase==='waitingIdle'&&same(row.binding,binding)))throw error('REFRESH_DEFERRED_BUSY','Adapter activation is in progress');}
  else if(!same(row.binding,binding)||row.phase==='blocked')throw error('CONFIG_EPOCH_CHANGED','Native helper selection is stale');
  if(!probe&&(!Number.isFinite(request.expiresAt)||request.expiresAt<=Date.now()))throw error('REQUEST_EXPIRED','Native request expired before execution');
 }
 function replacement(previous){
  if(!previous)return false;
  const old=previous.binding??previous.state?.binding;
  if(same(old,binding))return true;
  if(!old||old.installationId!==binding.installationId||old.root!==binding.root)throw error('IDENTITY_MISMATCH','Existing helper belongs to an old installation; restart the desktop during maintenance');
  const state=JSON.parse(fs.readFileSync(path.join(root,'runtime/updates/state.json'),'utf8')),transition=state.apps[app]?.transition;
  if(transition?.phase!=='attaching'||!same(transition.binding,binding))throw error('REFRESH_DEFERRED_BUSY','Use idle compatibility activation before replacing a live helper');
  return false;
 }
 check({binding},{probe:true});
 return {check,replacement,binding};
}
async function loadedThreadIds(connection){
 const ids=new Set(),cursors=new Set();let cursor=null;
 for(let page=0;page<100;page++){
  const result=await connection.sendAppServerRequest('thread/loaded/list',{cursor,limit:100});
  if(!Array.isArray(result?.data)||result.data.some(id=>typeof id!=='string'))throw error('CONTRACT_MISMATCH','Loaded-thread response is invalid');
  result.data.forEach(id=>ids.add(id));if(ids.size>10000)throw error('CONTRACT_MISMATCH','Loaded-thread inventory exceeds the safe bound');
  if(result.nextCursor==null)return [...ids];
  if(typeof result.nextCursor!=='string'||cursors.has(result.nextCursor))throw error('CONTRACT_MISMATCH','Loaded-thread pagination is invalid');
  cursor=result.nextCursor;cursors.add(cursor);
 }
 throw error('CONTRACT_MISMATCH','Loaded-thread inventory did not finish');
}
module.exports={createGuard,same,loadedThreadIds};
