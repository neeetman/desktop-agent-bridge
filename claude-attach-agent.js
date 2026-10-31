// Frida runs this in its own JS runtime. Application JS is evaluated only from
// a valid Node-API callback on Claude's main JS thread, using the same napi_env.
const applicationCode = __APPLICATION_CODE__;
let applicationBytes = 0;
for (const character of applicationCode) {
  const code = character.codePointAt(0);
  applicationBytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
}
const executable = Process.getModuleByName('Claude.exe');
const native = (name, result, args) => new NativeFunction(executable.getExportByName(name), result, args);
const createString = native('napi_create_string_utf8', 'int', ['pointer', 'pointer', 'uint64', 'pointer']);
const runScript = native('napi_run_script', 'int', ['pointer', 'pointer', 'pointer']);
const getString = native('napi_get_value_string_utf8', 'int', ['pointer', 'pointer', 'pointer', 'uint64', 'pointer']);
const openScope = native('napi_open_handle_scope', 'int', ['pointer', 'pointer']);
const closeScope = native('napi_close_handle_scope', 'int', ['pointer', 'pointer']);
const isPending = native('napi_is_exception_pending', 'int', ['pointer', 'pointer']);
const clearException = native('napi_get_and_clear_last_exception', 'int', ['pointer', 'pointer']);
let installed = false, busy = false, lastError = '';
const hooks = [];
function evaluate(env) {
  if (installed || busy) return;
  busy = true;
  try {
    const pending = Memory.alloc(1);
    if (isPending(env, pending) !== 0 || pending.readU8()) return;
    const scope = Memory.alloc(Process.pointerSize);
    if (openScope(env, scope) !== 0) return;
    try {
      const source = Memory.alloc(Process.pointerSize), result = Memory.alloc(Process.pointerSize);
      const text = Memory.allocUtf8String(applicationCode);
      const created = createString(env, text, applicationBytes, source);
      const ran = created === 0 ? runScript(env, source.readPointer(), result) : -1;
      if (ran !== 0) {
        // Our script must not leave an exception pending in the application's callback.
        const ignored = Memory.alloc(Process.pointerSize); clearException(env, ignored);
        send({ event: 'evaluation_failed', createStatus: created, runStatus: ran }); return;
      }
      const output = Memory.alloc(4096), size = Memory.alloc(8);
      if (getString(env, result.readPointer(), output, 4096, size) === 0) {
        const value = JSON.parse(output.readUtf8String());
        if (value.installed) { installed = true; send({ event: 'installed', ...value }); }
        else send({ event: 'skipped', ...value });
      }
    } finally { closeScope(env, scope.readPointer()); }
  } catch (error) { if (String(error) !== lastError) { lastError = String(error); send({ event: 'agent_error', error: lastError }); } }
  finally { busy = false; }
}
function hookModule(module) {
  if (!module.name.endsWith('.node')) return;
  const register = module.findExportByName('napi_register_module_v1');
  if (register) hooks.push(Interceptor.attach(register, { onEnter(args) { this.env = args[0]; }, onLeave() { evaluate(this.env); } }));
}
const observer = Process.attachModuleObserver({ onAdded: hookModule });
for (const name of ['napi_get_cb_info', 'napi_create_promise', 'napi_get_undefined', 'napi_get_boolean', 'napi_call_function', 'napi_make_callback']) {
  hooks.push(Interceptor.attach(executable.getExportByName(name), { onEnter(args) { this.env = args[0]; this.skip = busy || installed; }, onLeave() { if (!this.skip) evaluate(this.env); } }));
}
send({ event: 'hooks_ready', pid: Process.id });
