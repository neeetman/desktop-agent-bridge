import {projectURL} from '../../lib/paths.mjs';
import {fileURLToPath} from 'node:url';
import {AntigravityTools} from './antigravity-native.mjs';
import {startBridge} from '../../core/bridge.mjs';

// Reads use the local conversation index, so this service also runs while the
// desktop is closed. Writes check the hub on each dispatch; the router keeps
// messages queued (APP_NOT_RUNNING) until Antigravity is running again.
const tools = new AntigravityTools({spillDirectory: fileURLToPath(projectURL('runtime/antigravity/long-messages/'))});
await tools.call('list_threads', {limit: 1});
const bridge = await startBridge({tools, stateDir: fileURLToPath(projectURL('runtime/antigravity/')), port: 43134, pollMs: 2000, enableIpc: false});
console.log('Antigravity desktop bridge ready on 127.0.0.1:43134');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void bridge.close().then(() => process.exit(0)));
