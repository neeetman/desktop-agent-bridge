import crypto from 'node:crypto';
export async function callPeerTool(name, args, { request, self, identity }) {
  switch (name) {
    case 'bridge_self': return identity(args);
    case 'bridge_list_threads': {
      const query = new URLSearchParams(Object.entries(args).filter(([k, v]) => k !== 'app' && v !== undefined));
      const apps = args.app && args.app !== 'all' ? [args.app] : ['codex', 'claude', 'deepseek'];
      const results = await Promise.allSettled(apps.map(async app => ({ app, ...await request('/v1/native', { app, route: `/v1/threads?${query}` }) })));
      return { results: results.map((r, i) => r.status === 'fulfilled' ? r.value : { app: apps[i], error: r.reason.message }) };
    }
    case 'bridge_read_thread': return request('/v1/native', { app: args.toApp, route: `/v1/threads/${encodeURIComponent(args.toThreadId)}` });
    case 'bridge_settings':return request('/v1/native',{app:args.toApp,route:`/v1/threads/${encodeURIComponent(args.toThreadId)}/settings`});
    case 'bridge_task':return request('/v1/native',{app:args.app,route:`/v1/tasks/${encodeURIComponent(args.taskId)}`});
    case 'bridge_set_permissions':return request('/v1/set-permissions',{from:await self(args),app:args.toApp,threadId:args.toThreadId,input:Object.fromEntries(['sandboxMode','approvalPolicy','writableRoots'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))});
    case 'bridge_projects':case 'bridge_models':case 'bridge_capabilities':return request('/v1/native',{app:args.app??'codex',route:`/v1/${name.slice('bridge_'.length)}`});
    case 'bridge_health':return request('/v1/health',{app:args.app??'all',subscribe:args.subscribe,...args.subscribe!==undefined?{from:await self(args)}:{}});
    case 'bridge_ack':return request('/v1/ack',{from:await self(args),messageId:args.messageId});
    case 'bridge_create_task':{
      const input=Object.fromEntries(['prompt','title','projectId','cwd','model','effort','taskVersion','writableRoots','sandboxMode','approvalPolicy'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
      return request('/v1/create-task',{from:await self(args),app:args.toApp,input,idempotencyKey:args.idempotencyKey});
    }
    case 'bridge_send': {
      const from = await self(args);
      const messageId = args.messageId ?? crypto.randomUUID();
      try {
        return await request('/v1/send', {from, to:{app:args.toApp,threadId:args.toThreadId},
          text:args.text, expectReply:args.expectReply, messageId, taskVersion:args.taskVersion});
      } catch(error) {
        if (error.status || !(['TimeoutError','AbortError'].includes(error.name) ||
            error.code === 23 || (error instanceof TypeError && /fetch failed/i.test(error.message)))) throw error;
        throw Object.assign(new Error(`Router acceptance unconfirmed. In this chat query bridge_message with messageId=${messageId}. Reuse this ID and identical input if retrying.`),
          {code:'SEND_RECEIPT_UNCONFIRMED', lookupMessageId:messageId});
      }
    }
    case 'bridge_outbox': return request('/v1/outbox', {from:await self(args), after:args.after, limit:args.limit, stage:args.stage});
    case 'bridge_reply': {
      const { message } = await request('/v1/message', { id: args.messageId });
      return request('/v1/reply', { from: await self(args, message), messageId: args.messageId, text: args.text });
    }
    case 'bridge_receive': return request('/v1/receive', { who: await self(args), after: args.after,includeArchived:args.includeArchived,summaryOnly:args.summaryOnly });
    case 'bridge_archive_messages':return request('/v1/archive-messages',{from:await self(args),messageIds:args.messageIds,reason:args.reason});
    case 'bridge_request_decision': return request('/v1/request-decision', { from: await self(args), to: { app: args.toApp, threadId: args.toThreadId }, question: args.question, options: args.options, recommendation: args.recommendation, context: args.context, messageId: args.messageId ?? crypto.randomUUID() });
    case 'bridge_answer_decision': {
      // The original request provides the authenticated routing identity when the SDK omits call metadata.
      const from = await self(args); return request('/v1/answer-decision', { from, decisionId: args.decisionId, answer: args.answer, context: args.context });
    }
    case 'bridge_decisions': return request('/v1/decisions', { who: await self(args), status: args.status ?? 'pending' });
    case 'bridge_message': return request('/v1/message', { id: args.messageId, from:await self(args) });
    default: throw new Error('Unknown desktop-bridge tool');
  }
}
