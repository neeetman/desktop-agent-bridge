export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const apiError = (status, message) => Object.assign(new Error(message), { status });
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeExecution(input, { allowWorkspace = false,allowExecutionPolicy=true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'Expected a JSON object');
  if(input.allowedWritableRoots!==undefined)throw apiError(403,'allowedWritableRoots is local operator configuration; a peer cannot change it');
  const executionKeys=['writableRoots','sandboxMode','approvalPolicy'],hasExecutionPolicy=executionKeys.some(key=>input[key]!==undefined);
  if(hasExecutionPolicy&&!allowExecutionPolicy)throw apiError(400,'Execution policies are only supported by Codex');
  if(hasExecutionPolicy&&input.threadId)throw apiError(400,'An existing thread retains its execution policy; peer wake requests cannot replace permissions');
  if(input.writableRoots!==undefined&&(!Array.isArray(input.writableRoots)||input.writableRoots.some(root=>typeof root!=='string'||!root.trim())))throw apiError(400,'writableRoots must be an absolute directory array');
  if(input.sandboxMode!==undefined&&!['workspace-write','read-only','danger-full-access'].includes(input.sandboxMode))throw apiError(400,'Unsupported sandboxMode');
  if(input.approvalPolicy!==undefined&&!['on-request','untrusted','never','on-failure'].includes(input.approvalPolicy))throw apiError(400,'Unsupported approvalPolicy');
  for (const field of ['model', 'effort', 'thinking', 'projectId', 'workspaceId', 'hostId', 'threadId','cwd','taskVersion']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim())) throw apiError(400, `${field} must be a nonempty string`);
  }
  if (input.workspaceId && !allowWorkspace) throw apiError(400, 'workspaceId is only supported by the DeepSeek backend');
  if (input.workspaceId && input.projectId && input.workspaceId !== input.projectId) throw apiError(400, 'workspaceId and projectId disagree');
  const projectId = input.workspaceId ?? input.projectId;
  if (input.effort && input.thinking && input.effort !== input.thinking) throw apiError(400, 'effort and thinking disagree');
  const requestedEffort = input.effort ?? input.thinking;
  const effort = requestedEffort==='median'?'medium':requestedEffort;
  if (effort && !EFFORTS.includes(effort)) throw apiError(400, `Unsupported effort: ${effort}`);
  if (input.threadId && (input.target || projectId || input.environment || input.cwd)) throw apiError(400, 'An existing thread keeps its project/environment/cwd; omit target, projectId/workspaceId, cwd and environment');
  if (input.target && (projectId || input.environment)) throw apiError(400, 'Use target or projectId/workspaceId/environment, not both');
  if (input.environment && !projectId) throw apiError(400, 'environment requires projectId or workspaceId');
  if (input.target !== undefined && (!input.target || typeof input.target !== 'object' || Array.isArray(input.target))) throw apiError(400, 'target must be an object');
  const target = input.target ? { ...input.target } : projectId ? { type: 'project', projectId, environment: input.environment ?? { type: 'local' } } : { type: 'projectless' };
  if (!['project', 'projectless'].includes(target.type)) throw apiError(400, 'This bridge supports local project and projectless sessions');
  if (target.type === 'project') {
    if (typeof target.projectId !== 'string' || !target.projectId.trim()) throw apiError(400, 'target.projectId is required');
    if (typeof target.environment === 'string') target.environment = { type: target.environment };
    if (target.environment !== undefined && (!target.environment || typeof target.environment !== 'object' || Array.isArray(target.environment))) throw apiError(400, 'environment must be local or {type:local}');
    if ((target.environment?.type ?? 'local') !== 'local') throw apiError(400, 'Worktree creation is not implemented; use a saved project with environment.type=local');
    target.environment ??= { type: 'local' };
  }
  return { target, model: input.model, effort, ...input.cwd?{cwd:input.cwd}:{},...Object.fromEntries(executionKeys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]])) };
}

export function nativeModelArgs(execution) {
  return { ...execution.model ? { model: execution.model } : {}, ...execution.effort ? { thinking: execution.effort } : {} };
}

export function queryThreads(raw, query) {
  const matches = item => {
    if ((query.get('kind') ?? raw.defaultKind ?? 'codex') !== 'all' && item.kind !== (query.get('kind') ?? raw.defaultKind ?? 'codex')) return false;
    for (const field of ['projectId', 'hostId']) if (query.has(field) && item[field] !== query.get(field)) return false;
    const status = typeof item.status === 'object' ? item.status.type : item.status;
    if (query.has('status') && status !== query.get('status')) return false;
    if (query.has('q') && !`${item.title ?? ''}\n${item.summary ?? ''}`.toLowerCase().includes(query.get('q').toLowerCase())) return false;
    return true;
  };
  const pinnedThreads = (raw.pinnedThreads ?? []).filter(matches);
  const seen = new Set(pinnedThreads.map(item => `${item.kind}:${item.hostId}:${item.id}`));
  const threads = (raw.threads ?? []).filter(matches).filter(item => !seen.has(`${item.kind}:${item.hostId}:${item.id}`));
  return { ...raw, pinnedThreads, threads, coverage: 'Filters apply to the native recent-thread window plus all pinned threads; this is not an exhaustive historical search.' };
}
