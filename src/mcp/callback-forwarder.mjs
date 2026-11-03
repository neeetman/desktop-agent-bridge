// A callback receipt acknowledges local storage. This durable cursor separately
// tracks enqueueing to the exact peer that created the task.
export class CallbackForwarder {
  constructor(router){this.router=router;this.busy=new Set();this.startedAt=Date.now();}
  async poll(app){
    if(this.busy.has(app))return;this.busy.add(app);
    const r=this.router;r.state.callbackCursors??={};r.state.callbackReplays??={};
    try{
      const cursor=r.state.callbackCursors[app],replays=r.state.callbackReplays[app]??[];
      const result=await r.backendRequest(app,`/v1/events?after=${replays.length?0:cursor??0}`);
      // A new installation does not replay historical reports automatically.
      if(cursor===undefined){r.state.callbackCursors[app]=Math.max(0,...(result.events??[]).filter(event=>!(Date.parse(event.time)>=this.startedAt)).map(event=>event.id));r.save();}
      for(const event of result.events??[]){
        const replay=replays.includes(event.id);
        if(!replay&&(cursor===undefined?!(Date.parse(event.time)>=this.startedAt):event.id<=cursor))continue;
        if(['session.outbound','decision.requested'].includes(event.type)){
          let origin=event.peerOrigin,taskVersion=event.taskVersion;
          if(replay&&!origin&&event.taskId){const task=await r.backendRequest(app,`/v1/tasks/${encodeURIComponent(event.taskId)}`);origin=task.peerOrigin;taskVersion??=task.taskVersion;}
          if(origin&&event.threadId){
            const common={from:{app,threadId:event.threadId},to:origin,messageId:`callback:${app}:${event.id}`};
            if(event.type==='decision.requested')await r.requestDecision({...common,question:event.question,options:event.options,recommendation:event.recommendation,context:`Callback decision ID: ${event.decisionId}\n${event.context??''}`});
            else await r.send({...common,text:event.text,taskVersion:taskVersion??undefined,expectReply:event.kind!=='progress'});
          }else if(replay)throw Object.assign(Error('Callback has no verified task origin'),{code:'CALLBACK_ORIGIN_MISSING'});
        }
        if(replay)r.state.callbackReplays[app]=r.state.callbackReplays[app].filter(id=>id!==event.id);
        r.state.callbackCursors[app]=Math.max(r.state.callbackCursors[app]??0,event.id);r.save();
      }
      const next=Math.max(r.state.callbackCursors[app]??0,result.cursor??0);
      if(next!==r.state.callbackCursors[app]||r.state.callbackErrors?.[app]){r.state.callbackCursors[app]=next;delete r.state.callbackErrors?.[app];r.save();}
    }finally{this.busy.delete(app);}
  }
}
