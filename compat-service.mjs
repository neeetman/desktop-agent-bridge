import {Compatibility,compatError,sameBinding} from './compatibility.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
try{
 const data=JSON.parse(Buffer.concat(chunks).toString()||'{}'),service=new Compatibility();let result;
 if(process.argv[2]==='resolve')result=await service.resolve(data.app,data.capability,{pid:data.pid});
 else if(process.argv[2]==='report')result=await service.report(data.app,data.binding,data.phase,data.details);
 else if(process.argv[2]==='validate'){
  const state=service.state(),row=state.apps[data.app],selection=service.evaluate(data.app,await service.inventory(),state,data.profile.id);
  if(selection.generation!==data.binding.generation||selection.profileDigest!==data.binding.profileDigest||selection.adapterRoot!==data.adapterRoot||!sameBinding(row?.transition?.binding??row?.binding,data.binding))throw compatError('IDENTITY_MISMATCH','Attachment selection changed');result={validated:true};
 }
 else if(process.argv[2]==='launch-plan'){const selected=service.evaluate(data.app,{processes:[{app:data.app,pid:0,createdAt:'launch',executable:data.executable}],installed:[]},{apps:{}},null);result={validated:true,profileId:selected.profile.id};}
 else if(process.argv[2]==='check-build'){const selected=service.evaluate(data.app,{processes:[{app:data.app,pid:0,createdAt:'preflight',executable:data.executable}],installed:[]},{apps:{}},null);result={app:data.app,executable:data.executable,hashesValidated:true,profileId:selected.profile.id};}
 else throw compatError('INVALID_ARGUMENT','Unknown compatibility worker operation');
 process.stdout.write(JSON.stringify(result));
}catch(error){process.stdout.write(JSON.stringify({error:error.message,code:error.code??'COMPATIBILITY_ERROR',dispatchNotStarted:true}));process.exitCode=1;}
