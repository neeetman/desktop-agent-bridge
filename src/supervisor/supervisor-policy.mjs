import path from 'node:path';
export const backoffMs = (failures, base = 1000, ceiling = 60000) => Math.min(ceiling, base * 2 ** Math.max(0, Math.min(16, failures - 1)));
export function childEnvironment(source = process.env, config = {}) {
  const result = { ...source };
  for (const name of Object.keys(result)) if ((name.startsWith('CODEX_') && name !== 'CODEX_HOME') || /^CLAUDE_CODE_(?:HOST_SESSION_ID|SESSION_ID|ENTRYPOINT)$/.test(name)) delete result[name];
  if (config.codexHome) result.CODEX_HOME = config.codexHome;
  if (config.node) result.PATH = path.dirname(config.node) + path.delimiter + (result.PATH ?? result.Path ?? '');
  return result;
}
export function matchesScript(row, script, allowRelative = false) {
  if (!row || !row.CommandLine) return false;
  const normalized = value => value.replaceAll('/', '\\').toLowerCase();
  const command = normalized(row.CommandLine), absolute = normalized(script);
  if (command.includes(`"${absolute}"`) || command.includes(` ${absolute} `) || command.endsWith(` ${absolute}`)) return true;
  if (!allowRelative) return false;
  const name = normalized(path.basename(script));
  return command.includes(` ${name} `) || command.endsWith(` ${name}`);
}
export function shouldRecover({ alive, healthy, ageMs, failures, graceMs = 90000 }) {
  if (!alive) return 'missing';
  if (healthy) return null;
  if (ageMs < graceMs) return null;
  return failures >= 3 ? 'unhealthy' : null;
}
export function restoreAppState(name, config, previous, sameLogon) {
  const saved=sameLogon?previous?.[name]:null;
  return {...config,name,pid:null,previousPid:saved?.pid??null,closedByUser:saved?.closedByUser??false,lastExitCode:saved?.lastExitCode??null,nextStart:0,failures:0,launchAtLogin:!saved?.closedByUser};
}
export function installedDesktopExecutable(name, packages) {
  const identity = {codex:'OpenAI.Codex',claude:'Claude'}[name];
  const executable = {codex:'ChatGPT.exe',claude:'Claude.exe'}[name];
  const installed = packages.find(row => row.Name === identity);
  if (!identity || !installed?.InstallLocation) return null;
  return path.win32.join(installed.InstallLocation, 'app', executable);
}
export function runningDesktopCandidates(app,rows){
 const values=[...rows.values()],same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
 return values.filter(row=>{
  const executable=row.ExecutablePath;if(!executable)return false;
  const matches=same(executable,app.executable)||same(executable,app.installedExecutable)||app.name==='codex'&&/\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(executable)||app.name==='claude'&&/\\Claude_[^\\]+\\app\\Claude\.exe$/i.test(executable);
  return matches&&!same(rows.get(row.ParentProcessId)?.ExecutablePath,executable);
 });
}
