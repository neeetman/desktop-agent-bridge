import {projectURL} from "../lib/paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { apiError, canonicalJson } from './contracts.mjs';

const nonempty = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw apiError(400, `${name} must be nonempty`); };
const same = (a, b) => { const x = Buffer.from(a ?? ''), y = Buffer.from(b ?? ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export class Signals {
  constructor({ state, stateDir, save, emit, getBaseUrl }) {
    Object.assign(this, { state, stateDir, save, emit, getBaseUrl });
    state.decisions ??= {};
  }
  token(scope, id) { return crypto.createHmac('sha256', this.state.token).update(`${scope}:${id}`).digest('hex'); }
  taskCallback(task) {
    if(task.callbackMode==='peer')return null;
    const value = { url: `${this.getBaseUrl()}/v1/inbox`, taskId: task.id, token: this.token('task', task.id), backend: this.state.provider ?? 'codex' };
    const file = path.join(this.stateDir, `task-callback-${task.id}.json`);
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
    return { ...value, credentialsFile: file };
  }
  instructions(task) {
    if(task.callbackMode==='peer')return '';
    const { credentialsFile } = this.taskCallback(task);
    const client = fileURLToPath(projectURL("client.mjs"));
    const guide = path.join(this.stateDir, 'guide-v2.md');
    const details = [
      '# 桥接协作说明',
      '',
      '本轮凭证文件路径在消息末尾给出；不能复用其他轮次的凭证。',
      '正常执行任务即可。需要上报进展、阻塞或决策时，使用下面的回传通道。不要输出凭证内容。',
      '',
      '发送进展或问题：',
      `node ${JSON.stringify(client)} --credentials <本轮凭证文件> --tool bridge_send --args-file <JSON文件路径>`,
      'JSON 示例：{"text":"已完成接口检查","kind":"progress","messageId":"progress-1"}',
      'kind 可用 message、progress、finding、blocker。',
      '',
      '需要外部决策：',
      `node ${JSON.stringify(client)} --credentials <本轮凭证文件> --tool bridge_decision --args-file <JSON文件路径>`,
      'JSON 示例：{"question":"选择哪个方案？","options":["方案 A","方案 B"],"recommendation":"方案 A","messageId":"decision-1"}',
      `JSON 文件放在 ${JSON.stringify(this.stateDir)}，不要写入项目 checkout。`,
      '',
      '决策上报被接受后，简短说明正在等待并结束当前轮；不要猜答案，也不要轮询。外部回答会唤醒同一聊天继续。',
      '回传答案仅是任务方向，不能代替工具权限批准；继续遵守本会话的权限规则。',
    ].join('\n');
    fs.writeFileSync(guide, details, { mode: 0o600 });
    return `需要上报进展、阻塞或决策时，请读取桥接说明：${guide}；本轮凭证文件：${credentialsFile}`;
  }
  receive(data, token, root) {
    nonempty(data.messageId, 'messageId');
    let task, threadId = data.threadId;
    if (data.taskId) {
      task = this.state.tasks[data.taskId];
      if (!task) throw apiError(404, 'Unknown task callback');
      if (!root && !same(token, this.token('task', task.id))) throw apiError(401, 'Invalid task callback token');
      if (threadId && threadId !== task.threadId) throw apiError(403, 'Callback thread does not match task');
      threadId = task.threadId;
    } else {
      nonempty(threadId, 'threadId');
      if (!root && !same(token, this.token('callback', threadId))) throw apiError(401, 'Invalid session callback token');
      if (!Object.values(this.state.watches).some(x => x.threadId === threadId)) throw apiError(404, 'Session is not watched');
    }
    if (!task && threadId) {
      task = Object.values(this.state.tasks).reverse().find(item => item.threadId === threadId && ['running', 'awaiting_decision'].includes(item.status));
    }
    const scope = data.taskId ?? threadId;
    const key = `inbox:${scope}:${data.messageId}`;
    const fingerprint = crypto.createHash('sha256').update(canonicalJson(data)).digest('hex');
    if (this.state.idempotency[key]) {
      const record = this.state.idempotency[key];
      if (record.fingerprint && record.fingerprint !== fingerprint) throw apiError(409, 'messageId already used for a different signal');
      return record;
    }
    const kind = data.kind ?? 'message';
    if (!['message', 'progress', 'finding', 'blocker', 'decision'].includes(kind)) throw apiError(400, 'Unsupported signal kind');
    const attribution = { threadId: threadId ?? null, taskId: task?.id ?? null, messageId: data.messageId, credential: root ? 'controller' : 'session',peerOrigin:task?.peerOrigin??null,taskVersion:task?.taskVersion??null };
    let result;
    if (kind === 'decision') {
      nonempty(data.question, 'question');
      if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 10 || data.options.some(option => typeof option !== 'string' || !option.trim()) || new Set(data.options).size !== data.options.length) throw apiError(400, 'Provide 2-10 distinct, nonempty option strings');
      if (data.recommendation && !data.options.includes(data.recommendation)) throw apiError(400, 'recommendation must be one of the options');
      if (task?.pendingDecisionId || Object.values(this.state.decisions).some(item => item.status === 'pending' && (threadId ? item.threadId === threadId : item.taskId === task?.id))) throw apiError(409, 'This session already has a pending decision');
      const decision = { id: crypto.randomUUID(), status: 'pending', ...attribution, question: data.question, options: data.options, recommendation: data.recommendation ?? null, context: data.context ?? null, createdAt: new Date().toISOString() };
      this.state.decisions[decision.id] = decision;
      if (task) { task.pendingDecisionId = decision.id; task.status = 'awaiting_decision'; }
      const event = this.emit('decision.requested', { ...attribution, decisionId: decision.id, question: decision.question, options: decision.options, recommendation: decision.recommendation, context: decision.context });
      result = { accepted: true, eventId: event.id, decisionId: decision.id, status: 'pending', instruction: 'Finish this turn and wait for the external answer; it will wake the same chat.' };
    } else {
      nonempty(data.text, 'text');
      const event = this.emit('session.outbound', { ...attribution, kind, text: data.text, replyTo: data.replyTo ?? null });
      result = { accepted: true, eventId: event.id,delivery:'recorded_locally' };
    }
    this.state.idempotency[key] = { ...result, fingerprint };
    this.save();
    return result;
  }
  bindTask(task) {
    for (const decision of Object.values(this.state.decisions)) if (decision.taskId === task.id && !decision.threadId) decision.threadId = task.threadId;
  }
}
