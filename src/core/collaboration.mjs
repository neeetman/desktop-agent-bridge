import path from 'node:path';
export function errorData(error,fallbackStatus=null){
  const httpStatus=Number.isInteger(error.status)?error.status:fallbackStatus;
  const codes={400:'INVALID_ARGUMENT',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',413:'PAYLOAD_TOO_LARGE',501:'NOT_IMPLEMENTED',502:'NATIVE_UNAVAILABLE',503:'NATIVE_UNAVAILABLE'};
  return {code:error.code??codes[httpStatus]??'BRIDGE_ERROR',message:error.message??String(error),httpStatus,...error.lookupMessageId?{lookupMessageId:error.lookupMessageId}:{},...error.dispatchNotStarted===undefined?{}:{dispatchNotStarted:error.dispatchNotStarted,dispatchStage:error.dispatchStage??'notStarted'}};
}
export function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:token|accessToken|refreshToken|authorization|apiKey|password|clientSecret)$/i.test(key)).map(([key,item])=>[key,publicResult(item)]));
}
export function codexModelCatalog(description) {
  const models=[];
  for(const match of description.matchAll(/([a-z0-9][a-z0-9.-]+) \(([^()]*)supported reasoning efforts: ([a-z, ]+)\)/gi))models.push({id:match[1],description:match[2].trim(),efforts:match[3].split(',').map(x=>x.trim())});
  if(!models.length)throw new Error('Native model declaration format changed; cannot safely infer model IDs');
  return {source:'running-desktop-create_thread-declaration',models,aliases:{'sol 6.1':'gpt-6.1-sol','sol6.1':'gpt-6.1-sol'},effortAliases:{median:'medium'}};
}
export function resolveSelection(catalog,model,effort){
  const id=catalog.aliases?.[model?.toLowerCase()]??model,selected=catalog.models.find(item=>item.id===id);
  if(!selected)throw Object.assign(new Error(`Unknown model ${model}; use bridge_models`),{status:400});
  if(effort&&!selected.efforts.includes(effort))throw Object.assign(new Error(`Model ${id} supports efforts: ${selected.efforts.join(', ')}`),{status:400});
  return id;
}
export function matchRegisteredCwd(projects,cwd,projectId){
  const normalize=value=>path.win32.resolve(value).replace(/[\\/]+$/,'').toLowerCase();
  const match=projects.find(item=>item.path&&normalize(item.path)===normalize(cwd)&&(!projectId||item.projectId===projectId));
  if(!match)throw Object.assign(new Error(`Requested cwd ${cwd} is not an exactly matching registered desktop project. Register that existing folder in Codex first; creation was refused before dispatch. The main checkout will not be substituted.`),{status:400});
  return {type:'project',projectId:match.projectId,environment:{type:'local'}};
}
export function bridgeHeader(message){return `[bridge ${JSON.stringify({from:`${message.from.app}:${message.from.threadId}`,kind:message.kind,messageId:message.id,replyTo:message.replyTo??null,expectReply:message.expectReply,taskVersion:message.taskVersion??null,receipt:message.receipt??null})}]`;}
